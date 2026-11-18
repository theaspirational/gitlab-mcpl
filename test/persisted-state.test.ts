/** A state file outlives the configuration that wrote it. Everything here
 * goes through readConfig, a real on-disk GitlabState reload, Poller.poll /
 * hotPoll and (for delivery) the MCPL server: no hand-made watch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, type Config } from '../src/config.js';
import { GitlabState, type GitlabStateSnapshot } from '../src/state.js';
import { Poller } from '../src/poller.js';
import type { NormalizedEvent, Pipeline } from '../src/types.js';
import { FakeGitLab, harness, mr, PROJECT, SHA, SHA2, TIME } from './harness.js';
const now = () => Date.parse(TIME) + 30000;
const dir = mkdtempSync(join(tmpdir(), 'gitlab-persisted-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
function cfg(extra: Record<string, string>): Config {
    const token = join(dir, 'token');
    writeFileSync(token, 'fixture-token', { mode: 0o600 });
    return readConfig({ GITLAB_URL: 'https://gitlab.invalid', GITLAB_TOKEN_FILE: token, GITLAB_PROJECTS: PROJECT, GITLAB_READ_ALLOW: PROJECT, ...extra });
}
let files = 0;
/** A restart: a fresh fake/scope under `extra`, its state loaded from disk. */
async function restart(saved: GitlabStateSnapshot, extra: Record<string, string>) {
    const file = join(dir, `state-${files++}.json`);
    writeFileSync(file, JSON.stringify(saved));
    const f = new FakeGitLab(cfg(extra));
    f.multi = true;
    f.state = GitlabState.load(file);
    await f.init();
    const events: NormalizedEvent[] = [];
    const poll = new Poller(f.ctx, async (e) => { events.push(e); return true; }, now);
    const start = f.calls.length;
    return { f, file, events, poll, calls: () => f.calls.slice(start).map(c => `${c.method} ${c.path}`), hot: () => Object.keys(f.state.memory<Record<string, unknown>>('hot', {})), disk: () => JSON.parse(readFileSync(file, 'utf8')) as GitlabStateSnapshot };
}
const below = (calls: string[]) => calls.filter(c => /\/(pipelines|jobs)(\/|$)/.test(c));
const failed = (id: number, sha: string, project_id?: number) => ({ id, sha, ref: 'topic', status: 'failed', updated_at: TIME, ...(project_id ? { project_id } : {}) }) as Pipeline;
/** List mode, EVENT_SOURCES=reviewing: one open MR with a running head pipeline. */
async function reviewerSnapshot() {
    const before = await new FakeGitLab(cfg({ GITLAB_EVENT_SOURCES: 'reviewing' })).init();
    before.mrs = [mr({ head_pipeline: { id: 10, sha: SHA, ref: 'topic', status: 'running' } })];
    await new Poller(before.ctx, async () => true, now).poll();
    assert.deepEqual(Object.keys(before.state.memory('hot', {})), [`${PROJECT}:10`]);
    return { saved: before.state.snapshot(), mrs: before.mrs };
}
/** List mode over two projects, default sources: an own MR in foreign/repo with a running head pipeline. */
async function ownSnapshot() {
    const before = new FakeGitLab(cfg({ GITLAB_PROJECTS: `${PROJECT},2`, GITLAB_READ_ALLOW: PROJECT }));
    before.multi = true;
    await before.init();
    before.mrs = [mr(), mr({ id: 56, iid: 8, project_id: 2, sha: SHA2, head_pipeline: { id: 12, sha: SHA2, ref: 'topic', status: 'running' } })];
    // The fixture's project-1 list is not per project: keep MR 8 out of it.
    before.override = c => c.path === `/projects/${PROJECT}/merge_requests` ? { status: 200, headers: { 'x-next-page': '' }, text: JSON.stringify(before.mrs.filter(m => m.project_id === 1 && m.state === 'opened')) } : undefined;
    await new Poller(before.ctx, async () => true, now).poll();
    assert.deepEqual(Object.keys(before.state.memory('hot', {})), ['foreign/repo:12']);
    assert.ok(before.state.pollCursors()['foreign/repo:own']);
    return before.state.snapshot();
}
// Restart across scope and source changes: list mode with
// EVENT_SOURCES=reviewing persists a reviewer hot watch; the same state file is
// then loaded under PROJECTS=*, EVENT_SOURCES=todos, which refuses `reviewing`.
test('reviewer watches persisted in list mode are not polled after a restart under PROJECTS=* EVENT_SOURCES=todos', async () => {
    const { saved } = await reviewerSnapshot();
    for (const exclude of ['', PROJECT]) {
        const r = await restart(saved, { GITLAB_PROJECTS: '*', GITLAB_EVENT_SOURCES: 'todos', GITLAB_PROJECTS_EXCLUDE: exclude });
        r.f.pipelines = [failed(10, SHA)];
        const h = await harness(r.f);
        try {
            await h.initialize();
            await h.grant();
            const poll = new Poller(r.f.ctx, h.server.onEvent, now);
            await poll.poll();
            await poll.hotPoll();
            // Only the to-do list is read: no pipeline, job or project read at all.
            assert.deepEqual(r.calls(), ['GET /todos', 'GET /todos'], `exclude=${exclude}`);
            assert.deepEqual(h.saw.filter(q => ['channels/incoming', 'channels/register', 'push/event'].includes(q.method)), []);
            assert.deepEqual(r.hot(), []);
            assert.deepEqual(r.disk().memory.hot, {});
            // The old per-project cursor went with it; the current source has its own.
            assert.deepEqual(Object.keys(r.f.state.pollCursors()), ['todos']);
            assert.deepEqual(h.violations, []);
        }
        finally {
            await h.close();
        }
    }
});
test('the same state under an unchanged configuration keeps its watch and cursors and still delivers', async () => {
    const { saved, mrs } = await reviewerSnapshot();
    const r = await restart(saved, { GITLAB_EVENT_SOURCES: 'reviewing' });
    r.f.mrs = mrs;
    r.f.pipelines = [failed(10, SHA)];
    const h = await harness(r.f);
    try {
        await h.initialize();
        await h.grant();
        const poll = new Poller(r.f.ctx, h.server.onEvent, now);
        await poll.revalidate();
        assert.deepEqual(r.calls(), []);
        assert.deepEqual(r.f.state.snapshot(), saved);
        await poll.hotPoll();
        const incoming = h.saw.filter(q => q.method === 'channels/incoming').flatMap(q => (q.params as { messages: { messageId: string; tags: string[] }[] }).messages);
        assert.equal(incoming.length, 1);
        assert.match(incoming[0].messageId, /^pipeline:team\/sub\/repo:10:failed/);
        assert.ok(incoming[0].tags.includes('gitlab:pipeline=reviewing'));
    }
    finally {
        await h.close();
    }
});
test('list mode: a watch is dropped when its source is switched off or its project leaves GITLAB_PROJECTS', async () => {
    // Source rule: reviewing -> todos, same project list.
    const reviewer = await restart((await reviewerSnapshot()).saved, { GITLAB_EVENT_SOURCES: 'todos' });
    reviewer.f.pipelines = [failed(10, SHA)];
    await reviewer.poll.hotPoll();
    assert.deepEqual(reviewer.calls(), []);
    assert.deepEqual(reviewer.hot(), []);
    assert.deepEqual(reviewer.disk().memory.hot, {});
    assert.deepEqual(reviewer.events, []);
    // Scope rule: foreign/repo removed from the list, sources unchanged.
    const saved = await ownSnapshot();
    const own = await restart(saved, {});
    own.f.pipelines = [failed(12, SHA2, 2)];
    await own.poll.hotPoll();
    assert.deepEqual(own.calls(), []);
    assert.deepEqual(own.hot(), []);
    assert.deepEqual(own.events, []);
    // The own-MR interest set and the cursors of the removed project go too; the listed project's stay.
    assert.deepEqual(Object.keys(own.f.state.memory<Record<string, unknown>>('own', {})), [`${PROJECT}!3`]);
    assert.deepEqual(Object.keys(own.f.state.pollCursors()).filter(k => k.startsWith('foreign/')), []);
    assert.ok(own.f.state.pollCursors()[`${PROJECT}:own`]);
    await own.poll.poll();
    assert.deepEqual(own.calls().filter(c => c.includes('foreign') || c.includes('/projects/2')), []);
    // Own-MR interest switched off (to-dos only): the watch has no source left.
    const off = await restart(saved, { GITLAB_PROJECTS: `${PROJECT},2`, GITLAB_EVENT_SOURCES: 'todos' });
    await off.poll.hotPoll();
    assert.deepEqual(off.calls(), []);
    assert.deepEqual(off.hot(), []);
    assert.deepEqual(off.f.state.memory('own', {}), {});
    // Control: unchanged list, the watch is polled and delivered.
    const same = await restart(saved, { GITLAB_PROJECTS: `${PROJECT},2` });
    same.f.pipelines = [failed(12, SHA2, 2)];
    await same.poll.hotPoll();
    assert.deepEqual(same.events.map(e => [e.kind, e.project, e.interest]), [['pipeline.finished', 'foreign/repo', 'own-mr']]);
});
test('all-projects mode: an own watch for a project excluded since is dropped before any pipeline read', async () => {
    const saved = await ownSnapshot();
    const all = { GITLAB_PROJECTS: '*' };
    // A path/prefix rule decides without touching the project at all.
    const byPath = await restart(saved, { ...all, GITLAB_PROJECTS_EXCLUDE: 'foreign/*' });
    await byPath.poll.hotPoll();
    assert.deepEqual(byPath.calls().filter(c => c.includes('foreign')), []);
    assert.deepEqual(below(byPath.calls()), []);
    assert.deepEqual(byPath.hot(), []);
    // An id rule needs the canonical id: one project resolve, nothing below it.
    const byId = await restart(saved, { ...all, GITLAB_PROJECTS_EXCLUDE: '2' });
    byId.f.pipelines = [failed(12, SHA2, 2)];
    await byId.poll.hotPoll();
    assert.deepEqual(byId.calls().filter(c => c.includes('foreign')), ['GET /projects/foreign/repo']);
    assert.deepEqual(below(byId.calls()), []);
    assert.deepEqual(byId.hot(), []);
    assert.deepEqual(byId.events, []);
    // A scope decision that cannot be made is not a pass: no pipeline read, watch kept for the retry.
    const down = await restart(saved, { ...all, GITLAB_PROJECTS_EXCLUDE: '2' });
    down.f.override = c => c.path === '/projects/foreign/repo' ? { status: 500, headers: {}, text: '{}' } : undefined;
    await assert.rejects(down.poll.hotPoll());
    await assert.rejects(down.poll.poll());
    assert.deepEqual(below(down.calls()), []);
    assert.deepEqual(down.hot(), ['foreign/repo:12']);
    // Control: not excluded, own-MR interest on -> still polled and delivered.
    const kept = await restart(saved, all);
    kept.f.pipelines = [failed(12, SHA2, 2)];
    await kept.poll.hotPoll();
    assert.deepEqual(kept.events.map(e => [e.kind, e.project, e.interest]), [['pipeline.finished', 'foreign/repo', 'own-mr']]);
    // List-mode cursors mean nothing under *: none survives to be resumed.
    assert.deepEqual(Object.keys(kept.f.state.pollCursors()).filter(k => !k.endsWith(':pipelines')), ['todos']);
});
