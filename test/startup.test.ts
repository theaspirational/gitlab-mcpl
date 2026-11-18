import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McplConnection, type JsonRpcRequest } from '@animalabs/mcpl-core';
import { Poller } from '../src/poller.js';
import { ProjectScope } from '../src/gitlab-adapter.js';
import { FakeGitLab, config, mr, PROJECT, SELF, SHA, until } from './harness.js';

async function promptly<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([request, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('MCPL discovery waited for GitLab validation')), 3000);
        })]);
    }
    finally { clearTimeout(timer); }
}

// A real CLI and loopback HTTP fixture: startup identity succeeds, then project
// resolution is held or its socket is destroyed. No remote network is used.
for (const mode of ['scope-slow', 'scope-slow-tcp', 'persisted-slow', 'persisted-unreachable']) {
    test(`tools/list serves before ${mode} validation; watches fail closed and recover`, { timeout: 15000 }, async () => {
        const persisted = mode.startsWith('persisted');
        const tcp = mode.endsWith('tcp');
        const fake = await new FakeGitLab(config({ allProjects: persisted, projects: persisted ? [] : [PROJECT], pipelineProjects: [], readAllow: [PROJECT] })).init();
        fake.mrs = [mr({ head_pipeline: { id: 10, sha: SHA, ref: 'topic', status: 'running' } })];
        await new Poller(fake.ctx, async () => true).poll();
        assert.equal(Object.keys(fake.state.memory('hot', {})).length, 1);
        fake.approvers = [{ user: { id: 8, username: 'fixture-reviewer' } }];
        fake.mrs[0].head_pipeline!.status = 'failed';
        fake.pipelines = [{ id: 10, sha: SHA, ref: 'topic', status: 'failed' }];
        const calls: string[] = [];
        let blocked = true;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const api = http.createServer((req, res) => {
            void (async () => {
                const url = new URL(req.url!, 'http://localhost');
                const path = decodeURIComponent(url.pathname.slice('/api/v4'.length));
                calls.push(`${req.method} ${path}`);
                if (blocked && (path === `/projects/${PROJECT}` || path === '/version')) {
                    if (mode.endsWith('unreachable')) {
                        req.socket.destroy();
                        return;
                    }
                    await held;
                }
                const r = fake.response({ method: req.method!, path, url, body: {} });
                res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
                res.end(r.text);
            })();
        });
        await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
        const dir = mkdtempSync(join(tmpdir(), 'gitlab-startup-'));
        const token = join(dir, 'token'), state = join(dir, 'state.json');
        writeFileSync(token, 'fixture-token', { mode: 0o600 });
        fake.state.bindIdentity(url, SELF.id);
        writeFileSync(state, JSON.stringify(fake.state.snapshot()));
        // Deliberately remove inherited GitLab configuration from the fixture.
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITLAB_')));
        let port = 0;
        if (tcp) {
            const reservation = net.createServer();
            await new Promise<void>(r => reservation.listen(0, '127.0.0.1', r));
            port = (reservation.address() as { port: number }).port;
            await new Promise<void>(r => reservation.close(() => r()));
        }
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...(tcp ? ['--tcp', String(port)] : ['--stdio'])], {
            env: { ...env, GITLAB_URL: url, GITLAB_ALLOW_HTTP: 'true', GITLAB_TOKEN_FILE: token,
                GITLAB_PROJECTS: persisted ? '*' : PROJECT, GITLAB_READ_ALLOW: PROJECT,
                GITLAB_WRITE_ALLOW: persisted ? PROJECT : undefined,
                GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.read,gitlab.comments',
                GITLAB_EVENT_SOURCES: 'own-mrs,pipelines', GITLAB_PIPELINE_PROJECTS: '',
                GITLAB_STATE_FILE: state, GITLAB_HOT_POLL_INTERVAL_MS: '10000' },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const closed = once(child, 'close');
        let stderr = '';
        child.stderr.on('data', b => { stderr += b.toString(); });
        if (tcp)
            await until(() => stderr.includes('Listening on loopback'));
        const host = tcp ? McplConnection.fromTcp(net.createConnection(port, '127.0.0.1')) : McplConnection.fromStreams(child.stdout, child.stdin);
        const events: string[] = [];
        host.on('request', (r: JsonRpcRequest) => {
            events.push(r.method);
            const p = r.params as { channels?: { id: string }[] };
            host.sendResponse(r.id, r.method === 'push/event' ? { accepted: true } : { results: (p.channels ?? []).map(c => ({ id: c.id, accepted: true })) });
        });
        try {
            await promptly(host.sendRequest('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'fixture', version: '1' } }));
            host.sendNotification('notifications/initialized');
            await promptly(host.sendRequest('ping'));
            await until(() => calls.includes(`GET /projects/${PROJECT}`));
            // These must complete WHILE the fixture remains blocked, not after
            // a timeout/revalidation. A hung old CLI fails the test timeout.
            await host.sendRequest('featureSets/update', { effectiveCapabilities: ['tools', 'channels.publish', 'channels.register', 'channels.lifecycle', 'pushEvents'] });
            const listed = await promptly(host.sendRequest('tools/list')) as { tools: { name: string }[] };
            assert.ok(listed.tools.some(t => t.name === 'comment'));
            if (!persisted) {
                await assert.rejects(host.sendRequest('channels/open', { channelId: `gitlab:${PROJECT}!3` }), /not ready/);
                const write = await host.sendRequest('tools/call', { name: 'comment', arguments: { thread: `${PROJECT}!3`, body: 'must not write' } });
                assert.match(JSON.stringify(write), /not ready/);
            }
            if (mode.endsWith('unreachable'))
                await until(() => stderr.includes('not revalidated yet'));
            assert.equal(events.length, 0);
            assert.ok(!calls.some(c => /\/(pipelines|merge_requests)(\/|$)/.test(c)));
            assert.ok(calls.every(c => c.startsWith('GET ')));
            blocked = false;
            release();
            // A new grant triggers a retry without waiting for the poll interval.
            await host.sendRequest('featureSets/update', { effectiveCapabilities: ['tools', 'channels.publish'] });
            await host.sendRequest('featureSets/update', { effectiveCapabilities: ['tools', 'channels.publish', 'pushEvents'] });
            await until(() => events.includes('push/event'));
            if (tcp)
                child.kill();
            else
                child.stdin.end();
            const [code] = await closed;
            assert.equal(code, 0, stderr);
        }
        finally {
            blocked = false;
            release();
            child.kill();
            host.close();
            api.closeAllConnections();
            await new Promise<void>(r => api.close(() => r()));
            await closed;
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

test('partial scope initialization is not authority, and failed initialization retries atomically', async () => {
    const f = new FakeGitLab(config({ projects: [PROJECT, '2'], pipelineProjects: [] }));
    f.multi = true;
    f.override = c => c.path === '/projects/2' ? { status: 500, headers: {}, text: '{}' } : undefined;
    const scope = new ProjectScope(f.adapter, f.config);
    await assert.rejects(scope.initialize());
    assert.equal(scope.ready, false);
    assert.equal(scope.event(1), undefined);
    await assert.rejects(scope.watch(PROJECT), /not ready/);
    await assert.rejects(scope.write(PROJECT), /not ready/);
    await assert.rejects(scope.persisted(PROJECT), /not ready/);
    // Explicit read authority never comes from a persisted watch.
    assert.equal((await scope.read(PROJECT)).id, 1);
    f.override = undefined;
    await scope.initialize();
    assert.equal(scope.ready, true);
    assert.equal((await scope.watch(PROJECT)).id, 1);
});

test('an unreachable identity endpoint still fails fast before serving', { timeout: 10000 }, async () => {
    const api = http.createServer(req => req.socket.destroy());
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-identity-'));
    const token = join(dir, 'token');
    writeFileSync(token, 'fixture-token', { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], {
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITLAB_'))), GITLAB_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`,
            GITLAB_ALLOW_HTTP: 'true', GITLAB_TOKEN_FILE: token, GITLAB_PROJECTS: PROJECT,
            GITLAB_FEATURE_SETS: 'gitlab.read,gitlab.events' },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    try {
        const [code] = await once(child, 'close');
        assert.equal(code, 1);
        assert.equal(stdout, '');
        assert.match(stderr, /transport failed.*\/user/);
        assert.ok(!stderr.includes('fixture-token'));
    }
    finally {
        child.kill();
        api.closeAllConnections();
        await new Promise<void>(r => api.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
    }
});
