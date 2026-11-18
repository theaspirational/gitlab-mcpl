import test from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller.js';
import type { NormalizedEvent, Todo } from '../src/types.js';
import { tagsFor } from '../src/tags.js';
import { FakeGitLab, config, mr, note, PROJECT, SHA, SHA2, SELF, TIME } from './harness.js';
const now = () => Date.parse(TIME) + 30000;
const todo = (id: number): Todo => ({
    id, action_name: 'mentioned', project: { id: 1, path_with_namespace: PROJECT }, target_type: 'MergeRequest', target: mr(), author: { id: 8, username: 'human' }, body: '@example-user please look', target_url: 'https://gitlab.invalid', created_at: TIME
});
test('pending + auto-done to-do race, dedup by id across states and restart', async () => {
    const f = await new FakeGitLab(config({ sources: ['todos'] })).init();
    f.todos = [todo(1), todo(2), { ...todo(3), project: { id: 2, path_with_namespace: 'foreign/repo' } }];
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    await poll.poll();
    await poll.poll();
    await new Poller(f.ctx, async (e) => { events.push(e); return true; }, now).poll();
    assert.deepEqual(events.map(e => e.id), ['todo:1', 'todo:2']);
    assert.ok(f.calls.some(c => c.url.searchParams.get('state') === 'done'));
    assert.ok(events.every(e => e.mention));
});
test('own MR notes, discussions, approvals; numeric self and no bot filter; system-note drop', async () => {
    const f = await new FakeGitLab(config({ sources: ['own-mrs'] })).init();
    f.notes = [note({ id: 1, author: SELF }), note({ id: 2, body: '@example-user hi' }), note({ id: 3, system: true }), note({ id: 4, body: '```\n@example-user\n```' })];
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    await poll.poll();
    assert.equal(events.length, 3);
    assert.equal(events[1].replyToSelf, true);
    assert.equal(events[1].mention, true);
    assert.equal(events[2].mention, false);
    f.approvers = [{ user: { id: 8, username: 'reviewer' } }];
    await poll.poll();
    assert.equal(events.at(-1)?.kind, 'mr.approval_changed');
    assert.equal(events.filter(e => e.kind === 'comment.created').length, 3);
    assert.equal(tagsFor(events[0], { ...SELF, username: 'renamed' }, []).metadata.fromSelf, true);
    assert.ok(!tagsFor(events[1], SELF, []).tags.some(x => x === 'chat:from-bot'));
});
test('failed delivery retains cursor and retries; a failed source does not poison other cursors', async () => {
    const f = await new FakeGitLab(config({ sources: ['todos', 'branches'], branchWatch: [`${PROJECT}:main`] })).init();
    f.todos = [todo(1)];
    let accept = false, count = 0;
    const poll = new Poller(f.ctx, async () => { count++; return accept; }, now);
    await assert.rejects(poll.poll());
    assert.ok(f.state.pollCursors().todos);
    assert.ok(f.state.pollCursors()[`branch:${PROJECT}:main`]);
    assert.equal(f.state.snapshot().pollKeys.length, 0);
    accept = true;
    await poll.poll();
    assert.equal(count, 2);
    assert.ok(f.state.pollCursors().todos);
});
test('reviewer head, merge, branch move and hot pipeline completion with failed job tail', async () => {
    const f = await new FakeGitLab(config({
        sources: ['reviewing', 'branches'], branchWatch: [`${PROJECT}:main`], eventLogBytes: 8, jobPatterns: ['deploy:*']
    })).init();
    f.mrs = [mr({ author: { id: 8, username: 'human' } })];
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    await poll.poll();
    assert.equal(events.length, 0);
    f.mrs[0].sha = SHA2;
    f.mrs[0].head_pipeline = {
        id: 11, sha: SHA2, ref: 'topic', status: 'running'
    };
    f.pipelines = [f.mrs[0].head_pipeline];
    f.head = SHA2;
    await poll.poll();
    assert.ok(events.some(e => e.kind === 'mr.head_changed'));
    assert.ok(events.some(e => e.kind === 'branch.moved'));
    f.pipelines[0].status = 'failed';
    f.jobs = [{
            id: 21, name: 'deploy:reader', status: 'failed', ref: 'topic', stage: 'deploy', failure_reason: 'script_failure'
        }];
    await poll.hotPoll();
    assert.ok(events.some(e => e.kind === 'pipeline.finished' && e.interest === 'reviewing'));
    assert.ok(events.some(e => e.kind === 'job.finished'));
    const finished = events.find(e => e.kind === 'pipeline.finished')!;
    assert.ok(JSON.stringify(finished.data).includes('log_tail'));
    assert.equal(tagsFor(finished, SELF, []).metadata.fromSelf, false);
    f.mrs[0].state = 'merged';
    f.mrs[0].merge_commit_sha = SHA2;
    await poll.poll();
    assert.ok(events.some(e => e.kind === 'mr.merged'));
});
test('own-MR, own-merge including fast-forward, ref and user interest; project channels', async () => {
    for (const rule of ['own-mrs', 'own-merges', 'users', 'refs']) {
        const f = await new FakeGitLab(config({
            sources: ['pipelines'], pipelineScope: [rule], pipelineUsers: ['project-token-bot'], pipelineRefs: ['main'], jobPatterns: ['deploy:*']
        })).init();
        f.pipelines = [{
                id: 11, sha: SHA, ref: 'main', status: 'failed', user: { id: 11, username: 'project-token-bot' }
            }];
        if (rule === 'own-merges')
            f.mrs = [mr({
                    state: 'merged', merged_at: TIME, merge_commit_sha: null, squash_commit_sha: null
                })];
        f.jobs = [{
                id: 22, name: 'deploy:reader', status: 'failed', ref: 'main', stage: 'deploy', failure_reason: 'script_failure'
            }];
        const events: NormalizedEvent[] = [];
        const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
        await poll.poll();
        await poll.poll();
        assert.equal(events.filter(e => e.kind === 'pipeline.finished').length, 1, rule);
        assert.equal(events.filter(e => e.kind === 'job.finished').length, 1, rule);
        assert.equal(events[0].thread?.number, rule === 'own-mrs' ? 3 : undefined);
        assert.equal(events[0].channel, rule === 'own-mrs' ? undefined : 'pipelines');
    }
});
test('failure event carries at most three bounded traces; watched jobs may be successful', async () => {
    const f = await new FakeGitLab(config({
        sources: ['pipelines'], pipelineScope: ['refs'], pipelineRefs: ['main'], eventLogBytes: 4, jobPatterns: ['deploy:*'], jobStatuses: ['success']
    })).init();
    f.pipelines = [{
            id: 1, sha: SHA, ref: 'main', status: 'failed'
        }];
    f.jobs = Array.from({ length: 4 }, (_, i) => ({
        id: 50 + i, name: 'test:' + i, status: 'failed', ref: 'main', stage: 'test'
    }));
    f.jobs.push({
        id: 55, name: 'deploy:reader', status: 'success', ref: 'main', stage: 'deploy'
    });
    const events: NormalizedEvent[] = [];
    await new Poller(f.ctx, async (e) => { events.push(e); return true; }, now).poll();
    assert.equal(f.calls.filter(c => c.path.endsWith('/trace')).length, 3);
    assert.ok(events.some(e => e.kind === 'job.finished' && e.status === 'success'));
});
test('no poll traffic without an event grant, including hot timer', async () => {
    const f = await new FakeGitLab().init();
    const n = f.calls.length;
    const p = new Poller(f.ctx, async () => false, now, () => false);
    await p.poll();
    await p.hotPoll();
    assert.equal(f.calls.length, n);
});
test('threads optional full source emits note and MR lifecycle with overlap dedup', async () => {
    const f = await new FakeGitLab(config({ sources: ['threads'] })).init();
    f.notes = [note()];
    const events: NormalizedEvent[] = [];
    const p = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    await p.poll();
    await p.poll();
    assert.equal(events.filter(e => e.kind === 'mr.opened').length, 1);
    assert.equal(events.filter(e => e.kind === 'comment.created').length, 1);
});
test('pipeline cursor cannot advance after its interest-source lookup fails', async () => {
    const f = await new FakeGitLab(config({ sources: ['pipelines'], pipelineScope: ['own-mrs'] })).init();
    f.override = c => c.path.endsWith('/merge_requests') ? {
        status: 403, headers: {}, text: '{}'
    } : undefined;
    await assert.rejects(new Poller(f.ctx, async () => true, now).poll());
    assert.equal(f.state.pollCursors()[`${PROJECT}:pipelines`], undefined);
    assert.ok(!f.calls.some(c => c.path.endsWith('/pipelines')));
});
test('hot polling prunes superseded reviewer heads', async () => {
    const f = await new FakeGitLab(config({ sources: ['reviewing'] })).init();
    f.mrs = [mr({ head_pipeline: {
                id: 1, sha: SHA, ref: 'topic', status: 'running'
            } })];
    const poll = new Poller(f.ctx, async () => true, now);
    await poll.poll();
    f.mrs = [mr({ sha: SHA2, head_pipeline: {
                id: 2, sha: SHA2, ref: 'topic', status: 'running'
            } })];
    await poll.poll();
    const hot = f.state.memory<Record<string, {
        pipeline: number;
    }>>('hot', {});
    assert.deepEqual(Object.values(hot).map(x => x.pipeline), [2]);
});
test('repeated branch/head transitions and approval reversals are not permanently deduped', async () => {
    const f = await new FakeGitLab(config({ sources: ['own-mrs', 'reviewing', 'branches'], branchWatch: [`${PROJECT}:main`] })).init();
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    await poll.poll();
    for (const [sha, approved] of [[SHA2, true], [SHA, false], [SHA2, true]] as const) {
        f.mrs[0].sha = sha;
        f.head = sha;
        f.approvers = approved ? [{ user: { id: 8, username: 'human' } }] : [];
        await poll.poll();
    }
    assert.equal(events.filter(e => e.kind === 'branch.moved').length, 3);
    assert.equal(events.filter(e => e.kind === 'mr.head_changed').length, 3);
    assert.equal(events.filter(e => e.kind === 'mr.approval_changed').length, 3);
});
test('a retried pipeline failing again is a new completion, not suppressed forever', async () => {
    const f = await new FakeGitLab(config({
        sources: ['pipelines'], pipelineScope: ['refs'], pipelineRefs: ['main']
    })).init();
    f.pipelines = [{
            id: 1, sha: SHA, ref: 'main', status: 'failed', updated_at: TIME
        }];
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    await poll.poll();
    await poll.poll();
    assert.equal(events.length, 1);
    f.pipelines[0].updated_at = '2026-11-16T12:00:20Z';
    await poll.poll();
    assert.equal(events.length, 2);
});
test('token expiry warning retries refused delivery and is durably deduplicated', async () => {
    const f = await new FakeGitLab(config({ sources: [] })).init();
    f.ctx.tokenExpiry = '2026-11-20';
    let accepted = false;
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return accepted; }, now);
    await assert.rejects(poll.poll());
    accepted = true;
    await poll.poll();
    await poll.poll();
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'token.expiring');
    assert.equal(f.state.memory('expiry-notice', null), '2026-11-20');
});

test('projectless and unsupported todos do not poison a valid mention', async () => {
    const f = await new FakeGitLab(config({ sources: ['todos'] })).init();
    f.todos = [{ id: 2, target_type: 'Key' }, { ...todo(3), project: undefined }, { ...todo(4), target: null }, todo(1)];
    const ids: string[] = [];
    await new Poller(f.ctx, async e => { ids.push(e.id); return true; }, now).poll();
    assert.deepEqual(ids, ['todo:1']);
});
test('initial polling cursor survives rejection, time advance, and durable reload', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { GitlabState } = await import('../src/state.js');
    const dir = mkdtempSync(`${tmpdir()}/gitlab-baseline-`);
    try {
        const f = await new FakeGitLab(config({ sources: ['todos'] })).init();
        f.ctx.state = GitlabState.empty(`${dir}/state.json`);
        f.override = c => c.path === '/todos' ? { status: 200, headers: { 'x-next-page': '' }, text: JSON.stringify(c.url.searchParams.get('state') === 'done' ? [todo(1)] : []) } : undefined;
        await assert.rejects(new Poller(f.ctx, async () => false, now).poll());
        const baseline = f.ctx.state.pollCursors().todos;
        f.ctx.state = GitlabState.load(`${dir}/state.json`);
        assert.deepEqual(f.ctx.state.pollCursors().todos, baseline);
        let accepted = 0;
        await new Poller(f.ctx, async () => { accepted++; return true; }, () => now() + 600000).poll();
        assert.equal(accepted, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('5001 pending todos remain deduplicated beyond ring capacity and across states', async () => {
    const f = await new FakeGitLab(config({ sources: ['todos'] })).init();
    const rows = Array.from({ length: 5001 }, (_, i) => todo(i + 1));
    f.override = c => {
        if (c.path !== '/todos') return;
        const page = Number(c.url.searchParams.get('page'));
        const slice = rows.slice((page - 1) * 100, page * 100);
        return { status: 200, headers: { 'x-next-page': page * 100 < rows.length ? String(page + 1) : '' }, text: JSON.stringify(slice) };
    };
    let count = 0;
    await new Poller(f.ctx, async () => { count++; return true; }, now).poll();
    assert.equal(count, 5001);
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { GitlabState } = await import('../src/state.js');
    const dir = mkdtempSync(`${tmpdir()}/gitlab-todos-`);
    try {
        // Exercise the durable serialization/load path, not only a new Poller.
        writeFileSync(`${dir}/state.json`, JSON.stringify(f.ctx.state.snapshot()));
        f.ctx.state = GitlabState.load(`${dir}/state.json`);
        await new Poller(f.ctx, async () => { count++; return true; }, now).poll();
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert.equal(count, 5001);
    assert.equal(Object.keys(f.ctx.state.memory('todo-seen', {})).length, 5001);
});
test('initial persistence failure retains the polling cursor and prevents source reads', async () => {
    const f = await new FakeGitLab(config({ sources: ['todos'] })).init();
    const flush = f.state.flush.bind(f.state);
    f.state.flush = async () => { throw new Error('disk unavailable'); };
    await assert.rejects(new Poller(f.ctx, async () => true, now).poll());
    const baseline = f.state.pollCursors().todos.since;
    assert.ok(!f.calls.some(c => c.path === '/todos'));
    f.state.flush = flush;
    f.override = c => {
        if (c.path !== '/todos') return;
        if (c.url.searchParams.get('state') === 'done')
            assert.equal(c.url.searchParams.get('page'), '1');
        return { status: 503, headers: {}, text: '{}' };
    };
    await assert.rejects(new Poller(f.ctx, async () => true, () => now() + 600000).poll());
    assert.equal(f.state.pollCursors().todos.since, baseline);
});

test('failure tails strip ANSI and GitLab section markers before the useful-byte cap', async () => {
    const f = await new FakeGitLab(config({ sources: ['pipelines'], pipelineScope: ['refs'], pipelineRefs: ['main'], eventLogBytes: 9 })).init();
    f.pipelines = [{ id: 1, sha: SHA, ref: 'main', status: 'failed' }];
    f.jobs = [{ id: 50, name: 'test', status: 'failed', ref: 'main', stage: 'test' }];
    f.trace = 'section_start:1795001606:prepare_executor[collapsed=true]\r\x1b[0KPreparing the "docker" executor\n\x1b[31mFAIL é\x1b[0m\nsection_end:1795001607:prepare_executor\r\x1b[0K';
    const events: NormalizedEvent[] = [];
    await new Poller(f.ctx, async e => { events.push(e); return true; }, now).poll();
    const jobs = events[0].data?.failed_jobs as { log_tail: string }[];
    assert.equal(jobs[0].log_tail, '\nFAIL é\n');
    assert.ok(Buffer.byteLength(jobs[0].log_tail) <= 9);
});

test('reviewing and threads lifecycle tags use the actual merge/close actor', async () => {
    for (const source of ['reviewing', 'threads']) {
        for (const actor of [{ id: 8, username: 'human' }, SELF]) {
            for (const state of ['merged', 'closed']) {
                const f = await new FakeGitLab(config({ sources: [source] })).init();
                f.mrs = [mr({ author: { id: 9, username: 'author' } })];
                const events: NormalizedEvent[] = [];
                const poll = new Poller(f.ctx, async e => { events.push(e); return true; }, now);
                await poll.poll();
                Object.assign(f.mrs[0], { state, updated_at: new Date(Date.parse(TIME) + 1000).toISOString(), merge_user: state === 'merged' ? actor : undefined, closed_by: state === 'closed' ? actor : undefined });
                await poll.poll();
                const event = events.find(e => e.kind === `mr.${state}`)!;
                assert.ok(event, `${source}/${state}`);
                assert.equal(event.actor?.id, actor.id, `${source}/${state}`);
                assert.ok(tagsFor(event, SELF, []).tags.includes(actor.id === SELF.id ? 'chat:from-self' : 'chat:from-human'));
            }
        }
    }
});

test('disabled failure tails make no trace requests or log_tail fields', async () => {
    const f = await new FakeGitLab(config({ sources: ['pipelines'], pipelineScope: ['refs'], pipelineRefs: ['main'] })).init();
    f.pipelines = [{ id: 1, sha: SHA, ref: 'main', status: 'failed' }];
    f.jobs = [{ id: 50, name: 'test', status: 'failed', ref: 'main', stage: 'test' }];
    const events: NormalizedEvent[] = [];
    await new Poller(f.ctx, async e => { events.push(e); return true; }, now).poll();
    assert.ok(!f.calls.some(c => c.path.endsWith('/trace')));
    assert.ok(!JSON.stringify(events).includes('log_tail'));
});
