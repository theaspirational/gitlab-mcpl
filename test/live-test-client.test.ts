import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitLab, PROJECT, until } from './harness.js';

test('isolated live-test client drives launcher, grants, commands and JSONL acknowledgements', { timeout: 20000 }, async () => {
    const fake = new FakeGitLab();
    const api = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const url = new URL(req.url!, 'http://localhost');
        const r = url.pathname === '/api/v4/personal_access_tokens/self'
            ? { status: 200, text: JSON.stringify({ scopes: ['api'], expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }) }
            : fake.response({ method: req.method!, path: decodeURIComponent(url.pathname.slice('/api/v4'.length)), url, body: JSON.parse(body || '{}') });
        res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(r.text);
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-live-client-'));
    writeFileSync(join(dir, 'token'), 'fixture-token', { mode: 0o600 });
    const env = {
        GITLAB_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`, GITLAB_ALLOW_HTTP: 'true',
        GITLAB_TOKEN_FILE: join(dir, 'token'), GITLAB_STATE_FILE: join(dir, 'state.json'),
        GITLAB_PROJECTS: PROJECT, GITLAB_READ_ALLOW: PROJECT,
        GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.read,gitlab.comments,gitlab.mr', GITLAB_EXPECT_USERNAME: 'example-user'
    };
    writeFileSync(join(dir, 'env'), Object.entries(env).map(([k, v]) => `${k}='${v}'`).join('\n'), { mode: 0o600 });
    const log = join(dir, 'events.jsonl');
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/live-test-client.ts', join(dir, 'env'), log], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b.toString());
    child.stderr.on('data', b => stderr += b.toString());
    const results = () => stdout.trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
    try {
        // Queue before initialize completes, exercising real stdin buffering.
        child.stdin.write('tools/list\ncall get_merge_request {"project":"team/sub/repo","iid":3}\ncheckpoint\n');
        await until(() => results().length >= 5);
        assert.ok(results()[2].tools.some((t: { name: string }) => t.name === 'comment'));
        const cp = results()[4].checkpoint;
        assert.equal(typeof cp, 'string');
        child.stdin.write(`call comment {"thread":"gitlab:${PROJECT}!3","body":"TEST_BODY"}\n`);
        await until(() => results().length >= 6);
        assert.ok(!results()[5].isError);
        assert.equal(fake.notes.length, 1);
        assert.equal(fake.notes[0].body, 'TEST_BODY');
        child.stdin.write(`rollback ${cp}\nchannels open gitlab:${PROJECT}!3\nfeatures gitlab.read\ntools/list\ncall invalid {}\nquit\n`);
        const [code] = await closed;
        assert.equal(code, 0, stderr);
        const out = results();
        assert.equal(out[6].success, true);
        assert.ok(out[7].channel);
        assert.ok(out[9].tools.every((t: { name: string }) => !['comment', 'create_merge_request', 'merge_at_sha'].includes(t.name)));
        assert.ok(out[10].error || out[10].isError);
        assert.equal(out[11].quit, true);
        assert.equal(fake.notes.length, 0);
        const events = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
        assert.ok(events.some(e => e.method === 'channels/register'));
        assert.ok(events.some(e => e.method === 'push/event'));
        assert.ok(!stdout.includes('fixture-token') && !stderr.includes('fixture-token'));
    } finally {
        child.kill('SIGKILL');
        await new Promise<void>(r => api.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
    }
});
