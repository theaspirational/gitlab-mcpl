import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McplConnection } from '@animalabs/mcpl-core';
import { FakeGitLab, PROJECT } from './harness.js';
test('CLI stdio startup and plain MCP read through real local fixture HTTP', async () => {
    const fake = new FakeGitLab();
    fake.scopes = ['read_api'];
    const methods: string[] = [];
    const api = http.createServer((req, res) => {
        assert.equal(req.headers['private-token'], 'fixture-cli-token');
        const url = new URL(req.url!, 'http://localhost');
        methods.push(req.method!);
        const r = fake.response({
            method: req.method!, path: decodeURIComponent(url.pathname.slice('/api/v4'.length)), url, body: {}
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.text);
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-cli-'));
    const token = join(dir, 'token');
    writeFileSync(token, 'fixture-cli-token', { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], {
        cwd: process.cwd(), env: {
            ...process.env, GITLAB_URL: `http://127.0.0.1:${(api.address() as {
                port: number;
            }).port}`, GITLAB_ALLOW_HTTP: 'true', GITLAB_TOKEN_FILE: token, GITLAB_PROJECTS: PROJECT, GITLAB_FEATURE_SETS: 'gitlab.read,gitlab.events', GITLAB_EXPECT_USERNAME: 'example-user', GITLAB_STATE_FILE: join(dir, 'state.json')
        }, stdio: ['pipe', 'pipe', 'pipe']
    });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr.on('data', b => stderr += b.toString());
    const host = McplConnection.fromStreams(child.stdout, child.stdin);
    try {
        await host.sendRequest('initialize', {
            protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli-test', version: '1' }
        });
        host.sendNotification('notifications/initialized');
        const result = await host.sendRequest('tools/call', { name: 'get_merge_request', arguments: { project: PROJECT, iid: 3 } }) as {
            isError?: boolean;
        };
        assert.ok(!result.isError);
        assert.ok(methods.every(x => x === 'GET'));
        assert.ok(!stderr.includes('fixture-cli-token'));
        child.stdin.end();
        const [code] = await closed;
        assert.equal(code, 0);
    }
    finally {
        child.kill();
        host.close();
        await new Promise<void>(r => api.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
    }
});
