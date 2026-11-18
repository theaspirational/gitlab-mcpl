#!/usr/bin/env node
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import { readConfig } from './config.js';
import { GitLabAdapter, ProjectScope, startup } from './gitlab-adapter.js';
import { GitlabState } from './state.js';
import { stderrLogger, type Logger } from './types.js';
import { GitLabMcplServer } from './server.js';
import { Poller } from './poller.js';
export async function main(args = process.argv.slice(2)): Promise<void> {
    const tcp = args.length === 2 && args[0] === '--tcp' && /^\d+$/.test(args[1]) ? Number(args[1]) : null;
    if (!(args.length === 1 && args[0] === '--stdio') && !(tcp && tcp > 0 && tcp <= 65535))
        throw new Error('Usage: gitlab-mcpl --stdio | --tcp <loopback port>');
    const config = readConfig();
    const output = stderrLogger();
    const levels = ['debug', 'info', 'warn', 'error'];
    const logger = Object.fromEntries(levels.map((level, i) => [level, i >= levels.indexOf(config.logLevel) ? output[level as keyof Logger] : () => { }])) as unknown as Logger;
    const api = new GitLabAdapter(config);
    // Fail fast on wrong account, invalid PAT/scopes and state identity before
    // accepting a host; project and version I/O need not delay discovery.
    const identity = await startup(api, config, logger);
    const scope = new ProjectScope(api, config);
    const state = GitlabState.load(config.stateFile, logger);
    state.bindIdentity(config.url, identity.user.id);
    await state.flush();
    const context = {
        api, scope, config, state, user: identity.user, logger, tokenExpiry: identity.expiresAt
    };
    const server = new GitLabMcplServer(context);
    const poller = new Poller(context, server.onEvent, () => Date.now(), () => server.eventsEnabled);
    server.onReady = () => {
        void poller.poll().catch(() => logger.warn('Initial poll incomplete; retained for retry'));
    };
    // Start only once the transport is attached/listening. No validation await
    // on the serving path; prune gates every normal/hot poll and retries scope
    // initialization on failure. Scope-dependent requests fail closed meanwhile.
    let versionCheck = Promise.resolve();
    const startValidation = () => {
        versionCheck = api.request<{ version: string }>('GET', '/version')
            .then(v => logger.info('GitLab version', { version: v.version }))
            .catch(() => logger.warn('GitLab version check deferred; diagnostic unavailable'));
        void poller.revalidate().catch(() => logger.warn('Persisted poll state not revalidated yet; polling waits for it'));
        poller.start();
    };
    let listener: net.Server | undefined;
    let stopping = false;
    let active: McplConnection | undefined;
    let stopResolve: () => void = () => { };
    const stopped = new Promise<void>(resolve => { stopResolve = resolve; });
    let serving: Promise<void> = Promise.resolve();
    const stop = () => {
        if (stopping)
            return;
        stopping = true;
        poller.stop();
        active?.close();
        listener?.close();
        stopResolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        if (!tcp) {
            active = McplConnection.fromStreams(process.stdin, process.stdout);
            serving = server.serve(active);
            startValidation();
            await serving;
        }
        else {
            listener = net.createServer(socket => {
                if (active) {
                    socket.destroy();
                    return;
                }
                active = McplConnection.fromTcp(socket);
                serving = server.serve(active).finally(() => { active = undefined; });
            });
            await new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(tcp, '127.0.0.1', resolve); });
            listener.on('error', () => { logger.error('TCP listener failed'); stop(); });
            logger.info('Listening on loopback', { port: tcp });
            startValidation();
            await stopped;
            await serving;
        }
    }
    finally {
        stop();
        await poller.whenIdle();
        await versionCheck;
        await state.flush();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch((err: unknown) => { stderrLogger().error(err instanceof Error ? err.message : 'Startup or transport failure'); process.exitCode = 1; });
