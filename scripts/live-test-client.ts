/** Deliberately small, isolated operator host. Never connect this to a live host. */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { McplConnection, type JsonRpcRequest } from '@animalabs/mcpl-core';

export const KIT_FEATURES = ['gitlab.events', 'gitlab.read', 'gitlab.comments', 'gitlab.mr'];
// No wildcard, incoming delivery, typing, sampling, or unrelated host powers.
// Checkpoint/rollback are authorized by the selected comments set, not state.*.
export const KIT_GRANTS = ['tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.publish'];

/** Same acknowledgements as test/harness.ts. Unknown requests fail closed. */
export function answerServerRequest(host: McplConnection, r: JsonRpcRequest, acceptPush = true): void {
    const p = r.params as {
        channels?: { id: string }[]; updated?: { id: string }[];
        messages?: { messageId: string }[];
    };
    if (r.method === 'push/event') host.sendResponse(r.id, { accepted: acceptPush });
    else if (r.method === 'channels/register' || r.method === 'channels/changed')
        host.sendResponse(r.id, { results: (p.channels ?? p.updated ?? []).map(c => ({ id: c.id, accepted: true })) });
    else if (r.method === 'channels/incoming')
        host.sendResponse(r.id, { results: (p.messages ?? []).map(m => ({ messageId: m.messageId, accepted: true })) });
    else host.sendError(r.id, -32601, 'Unsupported host request');
}

export async function command(host: McplConnection, line: string): Promise<unknown> {
    if (line === 'tools/list') return host.sendRequest('tools/list', {});
    const call = /^call (\S+) (.+)$/.exec(line);
    if (call) {
        const args: unknown = JSON.parse(call[2]);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected a JSON object');
        return host.sendRequest('tools/call', { name: call[1], arguments: args });
    }
    const features = /^features (\S+)$/.exec(line);
    if (features) return host.sendRequest('featureSets/update', {
        effectiveCapabilities: KIT_GRANTS, enabled: features[1].split(',')
    });
    if (line === 'checkpoint') return host.sendRequest('state/checkpoint', { featureSet: 'gitlab.comments' });
    const rollback = /^rollback (\S+)$/.exec(line);
    if (rollback) return host.sendRequest('state/rollback', { featureSet: 'gitlab.comments', checkpoint: rollback[1] });
    const open = /^channels open (\S+)$/.exec(line);
    if (open) return host.sendRequest('channels/open', { channelId: open[1] });
    throw new Error('Expected tools/list, call <tool> <json>, features <comma list>, checkpoint, rollback <id>, channels open <id>, or quit');
}

async function main(): Promise<void> {
    const [envFile, logFile, ...extra] = process.argv.slice(2);
    if (!envFile || !logFile || extra.length) throw new Error('Usage: live-test-client <private-env-file> <private-jsonl-log>');
    // Open before starting the server: never acknowledge events without a log.
    const log = openSync(logFile, 'a', 0o600);
    const launcher = new URL('../deploy/gitlab-mcpl', import.meta.url);
    const child = spawn(fileURLToPath(existsSync(launcher) ? launcher : new URL('../../deploy/gitlab-mcpl', import.meta.url)), ['--stdio'], {
        env: { ...process.env, GITLAB_MCPL_ENV_FILE: resolve(envFile) }, stdio: ['pipe', 'pipe', 'inherit']
    });
    const host = McplConnection.fromStreams(child.stdout, child.stdin);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const lines = input[Symbol.asyncIterator]();
    let stopping = false;
    const exited = new Promise<void>(done => {
        child.on('error', e => { console.error(e.message); process.exitCode = 1; done(); });
        child.on('close', code => {
            if (!stopping || code !== 0) process.exitCode = 1;
            input.close(); done();
        });
    });
    const stop = () => { stopping = true; input.close(); child.stdin.end(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    host.on('error', e => { console.error(e.message); process.exitCode = 1; stop(); });
    host.on('notification', n => appendFileSync(log, JSON.stringify(n) + '\n'));
    host.on('request', r => {
        // Log the original envelope once, including push/event and channels/incoming.
        appendFileSync(log, JSON.stringify(r) + '\n');
        answerServerRequest(host, r);
    });
    const print = (result: unknown) => console.log(JSON.stringify(result));
    try {
        print(await host.sendRequest('initialize', {
            protocolVersion: '2024-11-05', clientInfo: { name: 'isolated-live-test', version: '1' },
            capabilities: { experimental: { mcpl: { version: '0.5' } } }
        }));
        host.sendNotification('notifications/initialized');
        print(await host.sendRequest('featureSets/update', { effectiveCapabilities: KIT_GRANTS, enabled: KIT_FEATURES }));
        // Iterate immediately: piped commands queued during initialization are retained.
        for await (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (line === 'quit') { print({ quit: true }); break; }
            try { print(await command(host, line)); }
            catch (e) { print({ error: e instanceof Error ? e.message : String(e) }); }
        }
    } finally {
        stop();
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
        host.close();
        closeSync(log);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
