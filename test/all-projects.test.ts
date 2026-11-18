/** GITLAB_PROJECTS=* (opt-in all-projects mode), through the public config
 * and poll paths against the fake GitLab. Project 1 is team/sub/repo, 2 is
 * foreign/repo and 3 is secret/vault. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, ConfigError, type Config } from '../src/config.js';
import { Poller } from '../src/poller.js';
import type { NormalizedEvent, Pipeline, Todo, ToolResult } from '../src/types.js';
import { FakeGitLab, config, harness, mr, note, PROJECT, SHA, SHA2, TIME } from './harness.js';
const now = () => Date.parse(TIME) + 30000;
function env(extra: Record<string, string> = {}, base: Record<string, string> = { GITLAB_PROJECTS: '*', GITLAB_READ_ALLOW: PROJECT }): Config {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-all-'));
    const token = join(dir, 'token');
    writeFileSync(token, 'fixture-token', { mode: 0o600 });
    try {
        return readConfig({ GITLAB_URL: 'https://gitlab.invalid', GITLAB_TOKEN_FILE: token, ...base, ...extra });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
async function fake(extra: Record<string, string> = {}) {
    const f = new FakeGitLab(env({ GITLAB_PROJECTS_EXCLUDE: 'secret/*', ...extra }));
    f.multi = true;
    return f.init();
}
const todo = (id: number, project: Todo['project']): Todo => ({
    id, action_name: 'mentioned', project, target_type: 'MergeRequest', target: mr(), author: { id: 8, username: 'human' }, body: '@example-user please look', target_url: 'https://gitlab.invalid', created_at: TIME
});
const collect = (f: FakeGitLab) => {
    const events: NormalizedEvent[] = [];
    return { events, poll: new Poller(f.ctx, async (e) => { events.push(e); return true; }, now) };
};
const perProjectMrLists = (f: FakeGitLab) => f.calls.filter(c => c.method === 'GET' && /^\/projects\/.+\/merge_requests$/.test(c.path));
test('* is opt-in and explicit: nothing that defaulted to the project list widens silently', () => {
    const c = env({ GITLAB_PROJECTS_EXCLUDE: 'secret/*, 2 ,team/sub/other' });
    assert.equal(c.allProjects, true);
    assert.deepEqual(c.projects, []);
    assert.deepEqual(c.projectsExclude, ['secret/*', '2', 'team/sub/other']);
    assert.deepEqual(c.readAllow, [PROJECT]);
    assert.deepEqual(c.pipelineProjects, []);
    // READ_ALLOW has no default with *: unset is refused, empty means no reads, * must be written out.
    assert.throws(() => env({}, { GITLAB_PROJECTS: '*' }), /GITLAB_READ_ALLOW: must be set explicitly/);
    assert.deepEqual(env({ GITLAB_READ_ALLOW: '' }).readAllow, []);
    assert.deepEqual(env({ GITLAB_READ_ALLOW: '*' }).readAllow, ['*']);
    assert.deepEqual(env({ GITLAB_FEATURE_SETS: 'gitlab.events' }, { GITLAB_PROJECTS: '*' }).readAllow, []);
    const refused: Record<string, string>[] = [
        { GITLAB_PROJECTS: '*,team/sub/repo' }, { GITLAB_PROJECTS: 'team/*' }, { GITLAB_PROJECTS_EXCLUDE: '*' }, { GITLAB_PROJECTS_EXCLUDE: 'group' }, { GITLAB_PROJECTS_EXCLUDE: 'a/b:main' },
        { GITLAB_EVENT_SOURCES: 'todos,reviewing' }, { GITLAB_EVENT_SOURCES: 'threads' }, { GITLAB_PIPELINE_SCOPE: 'own-mrs,users' }, { GITLAB_PIPELINE_SCOPE: 'refs' },
        { GITLAB_MR_TARGET_ALLOW: 'main' }, { GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.merge', GITLAB_MERGE_TARGET_ALLOW: 'main' }
    ];
    for (const bad of refused)
        assert.throws(() => env(bad), ConfigError, JSON.stringify(bad));
    // Bounded, explicitly listed sources stay available.
    assert.deepEqual(env({ GITLAB_EVENT_SOURCES: 'todos,branches', GITLAB_BRANCH_WATCH: `${PROJECT}:main` }).branchWatch, [`${PROJECT}:main`]);
    assert.deepEqual(env({ GITLAB_PIPELINE_SCOPE: 'refs', GITLAB_PIPELINE_PROJECTS: PROJECT }).pipelineProjects, [PROJECT]);
    assert.deepEqual(env({ GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.merge', GITLAB_MERGE_TARGET_ALLOW: `${PROJECT}:main`, GITLAB_WRITE_ALLOW: PROJECT }).mergeTargetAllow, [`${PROJECT}:main`]);
});
test('option unset: list mode defaults are unchanged and the exclude variable is refused', async () => {
    const c = env({}, { GITLAB_PROJECTS: `${PROJECT},2` });
    assert.equal(c.allProjects, false);
    assert.deepEqual(c.projects, [PROJECT, '2']);
    assert.deepEqual(c.readAllow, [PROJECT, '2']);
    assert.deepEqual(c.pipelineProjects, [PROJECT, '2']);
    assert.throws(() => env({ GITLAB_PROJECTS_EXCLUDE: 'secret/*' }, { GITLAB_PROJECTS: PROJECT }), /only valid with GITLAB_PROJECTS=\*/);
    const f = await new FakeGitLab().init();
    f.todos = [todo(1, { id: 1, path_with_namespace: PROJECT }), todo(2, { id: 2, path_with_namespace: 'foreign/repo' })];
    const { events, poll } = collect(f);
    await poll.poll();
    assert.deepEqual(events.filter(e => e.kind === 'todo').map(e => e.id), ['todo:1']);
    assert.equal(f.calls.filter(c => c.path === '/merge_requests').length, 0);
    assert.ok(perProjectMrLists(f).length > 0);
    assert.ok(!f.calls.some(c => c.path === '/projects/2'));
    await assert.rejects(f.scope.write('foreign/repo'), /not in GITLAB_PROJECTS/);
});
test('scope: events follow exclude on canonical id/path; reads follow READ_ALLOW only; writes follow WRITE_ALLOW only', async () => {
    const f = await fake();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scope.watch('foreign/repo')).id, 2);
    await assert.rejects(f.scope.watch(3), /excluded by GITLAB_PROJECTS_EXCLUDE/);
    await assert.rejects(f.scope.watch('secret/vault'), /excluded by GITLAB_PROJECTS_EXCLUDE/);
    // Event scope is not write authority: without GITLAB_WRITE_ALLOW nothing is writable.
    await assert.rejects(f.scope.write('foreign/repo'), /not in GITLAB_WRITE_ALLOW/);
    await assert.rejects(f.scope.write(PROJECT), /not in GITLAB_WRITE_ALLOW/);
    // An explicit allow admits exactly its projects (by canonical id/path), and an exclude still wins over it.
    const allowed = await fake({ GITLAB_WRITE_ALLOW: `${PROJECT},secret/*` });
    assert.equal((await allowed.scope.write(1)).path_with_namespace, PROJECT);
    await assert.rejects(allowed.scope.write(2), /not in GITLAB_WRITE_ALLOW/);
    await assert.rejects(allowed.scope.write('secret/vault'), /excluded by GITLAB_PROJECTS_EXCLUDE/);
    await assert.rejects(f.scope.read('foreign/repo'), /not in GITLAB_READ_ALLOW/);
    assert.equal((await f.scope.read(PROJECT)).id, 1);
    // An id rule also covers the path spelling, and startup refuses excluded watches.
    const byId = await fake({ GITLAB_PROJECTS_EXCLUDE: '2' });
    await assert.rejects(byId.scope.watch('foreign/repo'), /excluded/);
    const watch = new FakeGitLab(env({ GITLAB_PROJECTS_EXCLUDE: 'secret/*', GITLAB_EVENT_SOURCES: 'branches', GITLAB_BRANCH_WATCH: 'secret/vault:main' }));
    watch.multi = true;
    await assert.rejects(watch.init(), /excluded/);
});
test('to-dos come from every visible project; excludes hold for rows that only reveal an id', async () => {
    const f = await fake({ GITLAB_EVENT_SOURCES: 'todos' });
    // Row 3 names project 3 by id with a misleading path: the canonical path decides.
    f.todos = [todo(1, { id: 1, path_with_namespace: PROJECT }), todo(2, { id: 2 } as Todo['project']), todo(3, { id: 3, path_with_namespace: 'innocent/alias' }), todo(4, { id: 9, path_with_namespace: 'gone/away' })];
    const { events, poll } = collect(f);
    await poll.poll();
    await poll.poll();
    assert.deepEqual(events.map(e => [e.id, e.project]), [['todo:1', PROJECT], ['todo:2', 'foreign/repo']]);
    assert.ok(f.calls.filter(c => c.path === '/todos').every(c => !c.url.searchParams.has('project_id')));
    // Each project is resolved once, then served from the cache.
    assert.equal(f.calls.filter(c => c.path === '/projects/2').length, 1);
    const byId = await fake({ GITLAB_EVENT_SOURCES: 'todos', GITLAB_PROJECTS_EXCLUDE: '2' });
    byId.todos = f.todos;
    const second = collect(byId);
    await second.poll.poll();
    assert.deepEqual(second.events.map(e => e.id), ['todo:1', 'todo:3']);
});
test('an unresolvable project fails the source and keeps its cursor instead of leaking or dropping', async () => {
    const f = await fake({ GITLAB_EVENT_SOURCES: 'todos' });
    f.todos = [todo(2, { id: 2, path_with_namespace: 'foreign/repo' })];
    let down = true;
    f.override = c => down && c.path === '/projects/2' ? { status: 500, headers: {}, text: '{}' } : undefined;
    const { events, poll } = collect(f);
    await assert.rejects(poll.poll());
    assert.equal(events.length, 0);
    const kept = f.state.pollCursors().todos.since;
    down = false;
    await poll.poll();
    assert.deepEqual(events.map(e => e.id), ['todo:2']);
    assert.ok(kept);
});
test('own MRs and their pipelines come from one instance query; excluded projects are never read', async () => {
    const f = await fake();
    f.mrs = [mr(), mr({ id: 56, iid: 8, project_id: 2, sha: SHA2, head_pipeline: null }), mr({ id: 57, iid: 9, project_id: 3 }), mr({ id: 58, iid: 12, project_id: 2, author: { id: 8, username: 'human' } })];
    f.notes = [note()];
    f.pipelines = [{ id: 12, sha: SHA2, ref: 'topic', status: 'failed', updated_at: TIME, project_id: 2 } as Pipeline];
    const { events, poll } = collect(f);
    await poll.poll();
    assert.deepEqual(events.filter(e => e.kind === 'comment.created').map(e => `${e.project}!${e.thread?.number}`).sort(), ['foreign/repo!8', `${PROJECT}!3`]);
    const finished = events.filter(e => e.kind === 'pipeline.finished');
    assert.deepEqual(finished.map(e => [e.project, e.thread?.number, e.interest]), [['foreign/repo', 8, 'own-mr']]);
    const instance = f.calls.filter(c => c.path === '/merge_requests');
    assert.deepEqual(instance.map(c => [c.url.searchParams.get('scope'), c.url.searchParams.get('state')]), [['created_by_me', 'opened'], ['created_by_me', 'merged']]);
    assert.equal(perProjectMrLists(f).length, 0);
    // Project 3 is resolved once for the exclude decision and nothing below it is read.
    assert.deepEqual(f.calls.filter(c => /^\/projects\/(3|secret\/vault)(\/|$)/.test(c.path)).map(c => c.path), ['/projects/3']);
    assert.ok(events.every(e => e.project !== 'secret/vault'));
    assert.ok(f.state.pollCursors()['foreign/repo:pipelines']);
    // When the last own MR in a project closes, its pipeline list is no longer read and its cursor is dropped.
    f.mrs[1].state = 'closed';
    const before = f.calls.length;
    await poll.poll();
    assert.ok(!f.calls.slice(before).some(c => c.path === '/projects/foreign/repo/pipelines'));
    assert.equal(f.state.pollCursors()['foreign/repo:pipelines'], undefined);
    assert.ok(f.state.pollCursors()[`${PROJECT}:pipelines`]);
});
test('own merges are found instance-wide; users/refs interest stays on explicitly listed pipeline projects', async () => {
    const f = await fake({ GITLAB_EVENT_SOURCES: 'pipelines', GITLAB_PIPELINE_SCOPE: 'own-merges,users', GITLAB_PIPELINE_USERS: 'ci-bot', GITLAB_PIPELINE_PROJECTS: PROJECT });
    const bot = { id: 11, username: 'ci-bot' };
    f.mrs = [mr({ id: 60, iid: 10, project_id: 2, state: 'merged', merged_at: TIME, merge_commit_sha: SHA2 }), mr({ id: 61, iid: 11, project_id: 3, state: 'merged', merged_at: TIME, merge_commit_sha: SHA2 })];
    f.pipelines = [
        { id: 31, sha: SHA2, ref: 'main', status: 'success', updated_at: TIME, project_id: 2 } as Pipeline,
        { id: 32, sha: 'c'.repeat(40), ref: 'main', status: 'failed', updated_at: TIME, user: bot, project_id: 2 } as Pipeline,
        { id: 33, sha: 'd'.repeat(40), ref: 'main', status: 'failed', updated_at: TIME, user: bot, project_id: 1 } as Pipeline,
    ];
    const { events, poll } = collect(f);
    await poll.poll();
    assert.deepEqual(events.map(e => [e.project, e.interest, e.channel]).sort(), [['foreign/repo', 'own-merge', 'pipelines'], [PROJECT, 'user', 'pipelines']]);
    assert.ok(!f.calls.some(c => c.path.startsWith('/projects/secret/vault/')));
    assert.equal(perProjectMrLists(f).length, 0);
});
test('a failed instance query skips pipeline reads so their cursors cannot pass an unknown interest set', async () => {
    const f = await fake({ GITLAB_PIPELINE_PROJECTS: PROJECT });
    f.override = c => c.path === '/merge_requests' && c.url.searchParams.get('state') === 'opened' ? { status: 500, headers: {}, text: '{}' } : undefined;
    const { poll } = collect(f);
    await assert.rejects(poll.poll(), /\*:own/);
    assert.ok(!f.calls.some(c => c.path.endsWith('/pipelines')));
    assert.equal(f.state.pollCursors()[`${PROJECT}:pipelines`], undefined);
});
test('runtime-discovered projects: lazy channels, routed delivery, excluded projects never reach the host', async () => {
    const soon = new Date(now() + 86400000).toISOString().slice(0, 10);
    const f = await fake({ GITLAB_EVENT_SOURCES: 'todos' });
    f.mrs = [mr(), mr({ id: 56, iid: 8, project_id: 2 })];
    f.todos = [todo(2, { id: 2, path_with_namespace: 'foreign/repo' }), todo(3, { id: 3, path_with_namespace: 'secret/vault' })];
    (f.todos[0] as Todo).target = f.mrs[1];
    const h = await harness(f);
    try {
        await h.initialize();
        await h.grant();
        assert.deepEqual(await h.host.sendRequest('channels/list', {}), { channels: [] });
        await new Poller({ ...f.ctx, tokenExpiry: soon }, h.server.onEvent, now).poll();
        const ids = (method: string, key: 'channels' | 'messages') => h.saw.filter(r => r.method === method).flatMap(r => (r.params as Record<string, { id?: string; channelId?: string }[]>)[key].map(x => x.id ?? x.channelId));
        assert.deepEqual(ids('channels/register', 'channels').sort(), ['gitlab:*@pipelines', 'gitlab:foreign/repo!8']);
        assert.deepEqual(ids('channels/incoming', 'messages').sort(), ['gitlab:*@pipelines', 'gitlab:foreign/repo!8']);
        // A hand-made event for an excluded project is acknowledged and dropped, not delivered.
        const n = h.saw.length;
        assert.equal(await h.server.onEvent({ id: 'x', kind: 'comment.created', project: 'secret/vault', thread: { project: 'secret/vault', number: 9, kind: 'mr' }, receivedAt: TIME }), true);
        assert.equal(h.saw.length, n);
        await assert.rejects(h.host.sendRequest('channels/open', { channelId: 'gitlab:secret/vault!9' }), /excluded/);
        await assert.rejects(h.host.sendRequest('channels/open', { channelId: 'gitlab:secret/vault@pipelines' }), /excluded/);
        const opened = await h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo@pipelines' }) as { channel: { id: string } };
        assert.equal(opened.channel.id, 'gitlab:foreign/repo@pipelines');
        // Reads did not widen with events: foreign/repo is in event scope, not in READ_ALLOW.
        const read = async (project: string, iid: number) => {
            try { return (await h.host.sendRequest('tools/call', { name: 'get_merge_request', arguments: { project, iid } }) as ToolResult).isError === true ? 'refused' : 'ok'; }
            catch { return 'refused'; }
        };
        assert.equal(await read('foreign/repo', 8), 'refused');
        assert.equal(await read(PROJECT, 3), 'ok');
        assert.deepEqual(h.violations, []);
    }
    finally {
        await h.close();
    }
});
// Compare identical gitlab.comments declarations and
// READ_ALLOW, only GITLAB_PROJECTS differs. Through readConfig, the MCPL server
// and the real adapter, a foreign project must receive no write request at all.
const WRITES = ['POST', 'PUT', 'DELETE', 'PATCH'];
const COMMENTS = { GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.read,gitlab.comments', GITLAB_READ_ALLOW: PROJECT };
async function commentProbe(base: Record<string, string>) {
    const f = new FakeGitLab(env({}, { ...COMMENTS, ...base }));
    f.multi = true;
    await f.init();
    f.mrs = [mr(), mr({ id: 56, iid: 8, project_id: 2 })];
    const h = await harness(f);
    await h.initialize();
    await h.grant();
    const writes = () => f.calls.filter(c => WRITES.includes(c.method)).map(c => `${c.method} ${c.path}`);
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
        try {
            const r = await h.host.sendRequest('tools/call', { name, arguments: args }) as ToolResult;
            return r.isError ? (r.content[0] as { text: string }).text : 'ok';
        }
        catch (e) { return (e as Error).message; }
    };
    return { f, h, writes, call };
}
test('write authority does not follow *: the same comments config posts nothing to a foreign project', async () => {
    assert.throws(() => env({}, { ...COMMENTS, GITLAB_PROJECTS: '*' }), /GITLAB_WRITE_ALLOW: required for gitlab\.comments with GITLAB_PROJECTS=\*/);
    for (const base of [{ GITLAB_PROJECTS: PROJECT }, { GITLAB_PROJECTS: '*', GITLAB_WRITE_ALLOW: PROJECT }] as Record<string, string>[]) {
        const { f, h, writes, call } = await commentProbe(base);
        const fence = base.GITLAB_PROJECTS === '*' ? /not in GITLAB_WRITE_ALLOW/ : /not in GITLAB_PROJECTS/;
        try {
            // Tool route, by path and by numeric id.
            assert.match(await call('comment', { thread: 'foreign/repo!8', body: 'hello' }), fence);
            assert.match(await call('comment', { thread: '2!8', body: 'hello' }), fence);
            assert.match(await call('upsert_sticky_comment', { thread: 'foreign/repo!8', marker: 'status', body: 'hello' }), fence);
            // Publication route: in * mode the event channel may exist, and still carries no write.
            if (base.GITLAB_PROJECTS === '*') {
                await h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8' });
                await assert.rejects(h.host.sendRequest('channels/publish', { channelId: 'gitlab:foreign/repo!8', content: [{ type: 'text', text: 'hello' }] }), fence);
            }
            else
                await assert.rejects(h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8' }), fence);
            assert.deepEqual(writes(), []);
            assert.equal(f.notes.length, 0);
            // The explicitly allowed project is written exactly as in list mode.
            assert.equal(await call('comment', { thread: `${PROJECT}!3`, body: 'hello' }), 'ok');
            assert.deepEqual(writes(), [`POST /projects/${PROJECT}/merge_requests/3/notes`]);
            assert.deepEqual(h.violations, []);
        }
        finally {
            await h.close();
        }
    }
});
test('rollback is fenced by the write allow too: a journaled foreign comment is not touched', async () => {
    const { f, h, writes } = await commentProbe({ GITLAB_PROJECTS: '*', GITLAB_WRITE_ALLOW: PROJECT });
    try {
        const cp = await h.host.sendRequest('state/checkpoint', { featureSet: 'gitlab.comments' }) as { checkpoint: string };
        f.notes = [note({ id: 300, author: { id: 7, username: 'example-user' } })];
        f.state.recordCreatedComment({ repo: 'foreign/repo', commentId: 300, review: false, thread: { number: 8, kind: 'mr' } });
        const done = await h.host.sendRequest('state/rollback', { featureSet: 'gitlab.comments', checkpoint: cp.checkpoint }) as { success: boolean };
        assert.equal(done.success, false);
        assert.deepEqual(writes(), []);
        assert.equal(f.notes.length, 1);
    }
    finally {
        await h.close();
    }
});
test('GITLAB_WRITE_ALLOW: required per write set with *, never a bare *, refused in list mode', () => {
    for (const set of ['gitlab.comments', 'gitlab.mr', 'gitlab.ci', 'gitlab.rebase', 'gitlab.merge']) {
        const sets = { GITLAB_FEATURE_SETS: `gitlab.events,${set}`, GITLAB_MERGE_TARGET_ALLOW: `${PROJECT}:main` };
        assert.throws(() => env(sets), new RegExp(`GITLAB_WRITE_ALLOW: required for ${set.replace('.', '\\.')} with`), set);
        assert.throws(() => env({ ...sets, GITLAB_WRITE_ALLOW: '' }), /GITLAB_WRITE_ALLOW: required/, set);
        assert.deepEqual(env({ ...sets, GITLAB_WRITE_ALLOW: `${PROJECT}, 2,team/*` }).writeAllow, [PROJECT, '2', 'team/*']);
    }
    for (const bad of ['*', 'group', 'a/b:main', `${PROJECT},*`])
        assert.throws(() => env({ GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.comments', GITLAB_WRITE_ALLOW: bad }), /GITLAB_WRITE_ALLOW: expected/, bad);
    // No write set declared: events/reads need no write allow, and none is implied.
    assert.deepEqual(env().writeAllow, []);
    // List mode: GITLAB_PROJECTS stays the write list and the new variable is refused, not ignored.
    assert.deepEqual(env({ GITLAB_FEATURE_SETS: 'gitlab.events,gitlab.comments' }, { GITLAB_PROJECTS: PROJECT }).writeAllow, []);
    assert.throws(() => env({ GITLAB_WRITE_ALLOW: PROJECT }, { GITLAB_PROJECTS: PROJECT }), /GITLAB_WRITE_ALLOW: only valid with GITLAB_PROJECTS=\*/);
});

test('own-MR pipeline interest has the same merge/list ordering in both project modes', async () => {
    for (const all of [false, true]) {
        for (const mergeDuringDetail of [false, true]) {
            const f = all ? await fake({ GITLAB_EVENT_SOURCES: 'pipelines' }) : await new FakeGitLab(config({ sources: ['pipelines'] })).init();
            const merged = { state: 'merged', merged_at: TIME, merge_commit_sha: SHA2 };
            f.mrs = [mr(mergeDuringDetail ? {} : merged)];
            f.pipelines = [{ id: 12, sha: SHA, ref: 'topic', status: 'success', updated_at: TIME }];
            if (mergeDuringDetail) f.override = c => {
                if (c.path.endsWith('/merge_requests/3')) Object.assign(f.mrs[0], merged);
                return undefined;
            };
            const { events, poll } = collect(f);
            await poll.poll();
            assert.deepEqual(events.filter(e => e.kind === 'pipeline.finished').map(e => [e.interest, e.thread?.number]), [[mergeDuringDetail ? 'own-mr' : 'own-merge', mergeDuringDetail ? 3 : undefined]], `${all}/${mergeDuringDetail}`);
        }
    }
});
