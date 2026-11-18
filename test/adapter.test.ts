import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GitLabAdapter, startup } from '../src/gitlab-adapter.js';
import { silentLogger } from '../src/types.js';
import { neutralize, bound } from '../src/safety.js';
import { config, FakeGitLab, PROJECT, SHA } from './harness.js';
test('every forbidden endpoint/method/key is denied before transport', async () => {
    let io = 0;
    const api = new GitLabAdapter(config({ featureSets: [
            'gitlab.read', 'gitlab.mr', 'gitlab.comments', 'gitlab.ci', 'gitlab.rebase', 'gitlab.merge'
        ], mergeTargetAllow: ['main'] }), async () => { io++; return {
        status: 200, headers: {}, text: '{}'
    }; });
    for (const tail of [
        'merge_ref', 'cancel_merge_when_pipeline_succeeds', 'auto_merge', 'approve', 'unapprove', 'draft_notes', 'anything'
    ])
        await assert.rejects(api.request('PUT', `/projects/:project/merge_requests/:iid/${tail}`));
    for (const key of ['merge_when_pipeline_succeeds', 'auto_merge', 'squash', 'state_event', 'skip_ci'])
        await assert.rejects(api.request('PUT', '/projects/:project/merge_requests/:iid', { body: { [key]: true } }));
    await assert.rejects(api.request('PUT', '/projects/:project/merge_requests/:iid', { body: { description: { auto_merge: true } } }));
    await assert.rejects(api.request('POST', '/graphql'));
    await assert.rejects(api.request('PUT', '/projects/:project/merge_requests/:iid/merge', { body: { sha: SHA, squash: true } }));
    await assert.rejects(api.request('PUT', '/projects/:project/merge_requests/:iid/merge', { body: { sha: 'abc' } }));
    await assert.rejects(api.request('PUT', '/projects/:project/merge_requests/:iid/rebase', { query: { skip_ci: true } }));
    assert.equal(io, 0);
});
for (const [set, method, path] of [['gitlab.merge', 'PUT', 'merge_requests/:iid/merge'], ['gitlab.rebase', 'PUT', 'merge_requests/:iid/rebase'], ['gitlab.ci', 'POST', 'jobs/:job/retry']])
    test(`${set} endpoint opt-in gate`, async () => {
        const f = await new FakeGitLab().init();
        const n = f.calls.length;
        await assert.rejects(f.adapter.request(method, `/projects/:project/${path}`, { params: {
                project: PROJECT, iid: 3, job: 1
            }, body: { sha: SHA } }));
        assert.equal(f.calls.length, n);
    });
test('all outgoing text, not just comments, is neutralised at the choke point', async () => {
    const f = await new FakeGitLab(config({ featureSets: ['gitlab.mr'] })).init();
    await f.adapter.request('PUT', '/projects/:project/merge_requests/:iid', { params: { project: PROJECT, iid: 3 }, body: { description: 'text\n \t/merge\n/submit_review approve', title: '/close' } });
    assert.deepEqual(f.calls.at(-1)!.body, { description: 'text\n \t/\u200bmerge\n/\u200bsubmit_review approve', title: '/\u200bclose' });
});
// This representative quick-action list covers known
// 17.11 names; the exhaustive ASCII starter test below proves the neutraliser
// independent of catalog completeness (also future/unknown quick actions).
const quickActions = 'merge approve unapprove rebase close reopen target_branch label unlabel relabel assign unassign assign_reviewer unassign_reviewer reviewer remove_reviewer due remove_due_date milestone remove_milestone title todo done subscribe unsubscribe lock unlock confidential unconfidential move duplicate clone promote relate unlink blocks blocked_by epic remove_epic iteration remove_iteration weight clear_weight estimate remove_estimate spend remove_time_spent time_tracking copy_metadata commands help award remove_award shrug tableflip cc remove_source_branch keep_source_branch wip draft ready submit_review publish review request_changes summarize make_public make_private health_status clear_health_status set_parent remove_parent linked_work_item zoom timeline'.split(' ');
for (const name of quickActions)
    test(`quick action /${name} is inert in all line positions`, () => {
        for (const prefix of [
            '', '\n', '\r\n', ' \t', '\n\n  ', '```md\n'
        ]) {
            const text = prefix + '/' + name + ' arg';
            assert.ok(neutralize(text).includes('/\u200b' + name));
            assert.equal(neutralize(neutralize(text)), neutralize(text));
        }
    });
test('neutraliser covers every ASCII word starter, preserves links, and UTF8 bounds', () => {
    for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_')
        assert.equal(neutralize('\n /' + c), '\n /\u200b' + c);
    assert.equal(neutralize('https://host/path and /merge inline'), 'https://host/path and /merge inline');
    assert.ok(Buffer.byteLength(bound('🙂🙂🙂', 7)) <= 7);
    assert.ok(Buffer.byteLength(bound('🙂🙂🙂', 7, true)) <= 7);
});
test('GET retries honor Retry-After; writes never retry', async () => {
    const waits: number[] = [];
    let calls = 0;
    const api = new GitLabAdapter(config({ featureSets: ['gitlab.comments'] }), async () => ({
        status: ++calls < 3 ? 429 : 200, headers: { 'retry-after': '2' }, text: '{}'
    }), async (ms) => { waits.push(ms); });
    await api.request('GET', '/user');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 2000]);
    calls = 0;
    await assert.rejects(api.request('POST', '/projects/:project/merge_requests/:iid/notes', { params: { project: 1, iid: 3 }, body: { body: 'hello' } }));
    assert.equal(calls, 1);
});
test('offset pagination and overflow never silently truncate', async () => {
    let calls = 0;
    const api = new GitLabAdapter(config(), async () => ({
        status: 200, headers: { link: '<https://evil.invalid>; rel="next"' }, text: JSON.stringify(++calls === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }])
    }));
    assert.equal((await api.list('/todos')).length, 101);
    assert.equal(calls, 2);
    const endless = new GitLabAdapter(config(), async () => ({
        status: 200, headers: {}, text: JSON.stringify(Array.from({ length: 100 }, () => ({ id: 1 })))
    }));
    await assert.rejects(endless.list('/todos'), /Pagination bound/);
});
test('numeric aliases and nested-group read scope; write/event scope is separate', async () => {
    const f = await new FakeGitLab(config({ readAllow: ['*'] })).init();
    assert.equal((await f.scope.read('2')).path_with_namespace, 'foreign/repo');
    await assert.rejects(f.scope.write('2'), /GITLAB_PROJECTS/);
    assert.equal(f.scope.event(2), undefined);
    const g = await new FakeGitLab(config({ readAllow: ['team/*'] })).init();
    assert.equal((await g.scope.read(1)).id, 1);
    await assert.rejects(g.scope.read(2));
});
test('startup read_api succeeds, write set missing api names the set, username mismatch', async () => {
    const f = await new FakeGitLab().init();
    f.scopes = ['read_api', 'write_repository'];
    const r = await startup(f.adapter, f.config, silentLogger());
    assert.equal(r.user.id, 7);
    assert.ok(!f.calls.some(c => c.path === '/version'));
    await assert.rejects(startup(f.adapter, { ...f.config, featureSets: ['gitlab.mr'] }, silentLogger()), /gitlab.mr requires token scope api/);
    await assert.rejects(startup(f.adapter, { ...f.config, expectUsername: 'wrong' }, silentLogger()), /mismatch/);
});
test('real local HTTP: token header, encoded paths, streamed tail and redirect refusal', async () => {
    const seen: {
        url: string;
        token: string | undefined;
    }[] = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url!, token: req.headers['private-token'] as string });
        if (req.url!.includes('/trace')) {
            res.end('x'.repeat(100000) + 'THE END');
            return;
        }
        res.writeHead(302, { location: 'http://127.0.0.1:1/steal' });
        res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as {
        port: number;
    }).port;
    try {
        const api = new GitLabAdapter(config({ url: `http://127.0.0.1:${port}` }));
        const tail = await api.request<string>('GET', '/projects/:project/jobs/:job/trace', { params: { project: PROJECT, job: 1 }, tailBytes: 10 });
        assert.equal(tail, 'xxxTHE END');
        await assert.rejects(api.request('GET', '/user'), /302/);
        assert.ok(seen[0].url.includes('team%2Fsub%2Frepo'));
        assert.equal(seen[0].token, 'fixture-token');
        assert.equal(seen.length, 2);
    }
    finally {
        await new Promise<void>(r => server.close(() => r()));
    }
});
test('RateLimit-Reset fallback and long Retry-After do not produce early retries', async () => {
    let calls = 0;
    let waited = 0;
    const reset = Math.floor(Date.now() / 1000) + 5;
    const api = new GitLabAdapter(config(), async () => ({
        status: ++calls === 1 ? 429 : 200, headers: { 'ratelimit-reset': String(reset) }, text: '{}'
    }), async (ms) => { waited = ms; });
    await api.request('GET', '/user');
    assert.ok(waited > 3000 && waited <= 5000);
    calls = 0;
    const slow = new GitLabAdapter(config(), async () => { calls++; return {
        status: 429, headers: { 'retry-after': '120' }, text: '{}'
    }; }, async () => { assert.fail('must not retry early'); });
    await assert.rejects(slow.request('GET', '/user'));
    assert.equal(calls, 1);
});
test('CR preprocessing cannot resurrect quick actions in any HTTP text carrier', async () => {
    const f = await new FakeGitLab(config({ featureSets: ['gitlab.comments', 'gitlab.mr'] })).init();
    const payload = '/\rrebase\n/\rtarget_branch production\n/\rapprove';
    const safe = '/\u200brebase\n/\u200btarget_branch production\n/\u200bapprove';
    assert.equal(neutralize(payload).replace(/\r/g, ''), safe);
    for (const kind of ['merge_requests', 'issues']) {
        for (const [method, tail] of [['POST', '/notes'], ['PUT', '/notes/77'], ['POST', '/discussions/d/notes']]) {
            f.override = () => ({ status: 200, headers: {}, text: '{}' });
            await f.adapter.request(method, `/projects/:project/${kind}/:iid${tail.replace('77', ':note').replace('/d/', '/:discussion/')}`, { params: { project: 1, iid: 3, note: 77, discussion: 'd' }, body: { body: payload } });
            assert.equal(f.calls.at(-1)!.body.body, safe);
        }
    }
    for (const method of ['POST', 'PUT']) {
        await f.adapter.request(method, `/projects/:project/merge_requests${method === 'PUT' ? '/:iid' : ''}`, { params: { project: 1, iid: 3 }, body: { title: payload, description: payload, labels: payload } });
        assert.deepEqual(f.calls.at(-1)!.body, { title: safe, description: safe, labels: safe });
    }
});
test('notes pagination honors short and empty filtered pages and rejects unsafe metadata', async () => {
    for (const length of [0, 99]) {
        let calls = 0;
        const api = new GitLabAdapter(config(), async () => ({ status: 200, headers: { 'x-next-page': ++calls === 1 ? '2' : '' }, text: JSON.stringify(calls === 1 ? Array.from({ length }, (_, id) => ({ id })) : [{ id: 100 }]) }));
        assert.equal((await api.list('/projects/:project/merge_requests/:iid/notes', { params: { project: 1, iid: 3 } })).length, length + 1);
        assert.equal(calls, 2);
    }
    for (const next of [undefined, '1', '3', 'https://evil.invalid', ['2', '3']]) {
        const api = new GitLabAdapter(config(), async () => ({ status: 200, headers: { 'x-next-page': next }, text: '[]' }));
        await assert.rejects(api.list('/projects/:project/merge_requests/:iid/notes', { params: { project: 1, iid: 3 } }), /pagination metadata/);
    }
});
test('retry endpoints are denied at the HTTP boundary too', async () => {
    const api = new GitLabAdapter(config({ featureSets: ['gitlab.ci'] }), async () => { throw new Error('transport must not run'); });
    for (const path of ['/projects/:project/pipelines/:pipeline/retry', '/projects/:project/jobs/:job/retry'])
        await assert.rejects(api.request('POST', path, { params: { project: 1, pipeline: 1, job: 1 }, body: {} }), /Endpoint not allowed/);
});

test('transport diagnostics distinguish reads and uncertain writes without leaking messages', async () => {
    for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ETIMEDOUT', 'ECONNRESET']) {
        let attempts = 0;
        const api = new GitLabAdapter(config({ featureSets: ['gitlab.comments'] }), async () => {
            attempts++;
            throw Object.assign(new Error('secret-token https://private/'), { code });
        });
        await assert.rejects(startup(api, config(), silentLogger()), error => {
            const message = (error as Error).message;
            assert.match(message, new RegExp(code));
            assert.match(message, /GET.*Read failed/);
            assert.doesNotMatch(message, /write|secret-token|https:\/\/private/i);
            if (code.includes('CERT')) assert.match(message, /GITLAB_CA_FILE/);
            return true;
        });
        await assert.rejects(api.request('POST', '/projects/:project/merge_requests/:iid/notes', {
            params: { project: 1, iid: 3 }, body: { body: 'hello' }
        }), /Write outcome may be unknown/);
        assert.equal(attempts, 2);
    }
});

test('native HTTPS path preserves certificate codes and explicit CA configuration', async t => {
    const https = (await import('node:https')).default;
    const { EventEmitter } = await import('node:events');
    const seen: unknown[] = [];
    t.mock.method(https, 'request', ((_url: URL, options: { ca?: string }) => {
        seen.push(options.ca);
        const request = new EventEmitter() as http.ClientRequest;
        request.end = (() => {
            queueMicrotask(() => request.emit('error', Object.assign(new Error('certificate verification failed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })));
            return request;
        }) as typeof request.end;
        return request;
    }) as typeof https.request);
    for (const ca of [undefined, 'PEM fixture']) {
        const api = new GitLabAdapter(config({ ca }));
        await assert.rejects(api.request('GET', '/user'), /SELF_SIGNED_CERT_IN_CHAIN.*GITLAB_CA_FILE.*Read failed/);
    }
    assert.deepEqual(seen, [undefined, 'PEM fixture']);
});

test('native trace transport strips chunk-split controls before retaining a UTF-8 byte tail', async t => {
    const { EventEmitter } = await import('node:events');
    const raw = '\x1b[0Ksection_start:123:script[collapsed=true]\r\x1b[0KRun\n\x1b[31mFAIL é中文😀\x1b[0m\nprogress 10%\rprogress 100%\nuser section_start:123:real prose\r\x1b]0;title\x07\x1b[0Ksection_end:124:script\r\x1b[0K';
    t.mock.method(http, 'request', ((_url: URL, _opts: unknown, respond: (res: http.IncomingMessage) => void) => {
        const req = new EventEmitter() as http.ClientRequest;
        req.end = (() => {
            queueMicrotask(() => {
                const res = new EventEmitter() as http.IncomingMessage;
                res.statusCode = 200; res.headers = {};
                respond(res);
                for (const byte of Buffer.from(raw)) res.emit('data', Buffer.from([byte]));
                res.emit('end');
            });
            return req;
        }) as typeof req.end;
        return req;
    }) as typeof http.request);
    const api = new GitLabAdapter(config({ url: 'http://fixture.invalid' }));
    const text = await api.request<string>('GET', '/projects/:project/jobs/:job/trace', {
        params: { project: 1, job: 1 }, tailBytes: 4096, cleanTrace: true
    });
    assert.equal(text, 'Run\nFAIL é中文😀\nprogress 10%\rprogress 100%\nuser section_start:123:real prose\r');
    const tail = await api.request<string>('GET', '/projects/:project/jobs/:job/trace', {
        params: { project: 1, job: 1 }, tailBytes: 9, cleanTrace: true
    });
    assert.equal(tail, Buffer.from(text).subarray(-9).toString('utf8'));
});
