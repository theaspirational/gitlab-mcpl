/** Which authority each public path needs before it reads GitLab: READ
 * (GITLAB_READ_ALLOW), WRITE (GITLAB_WRITE_ALLOW, or GITLAB_PROJECTS in list
 * mode) or EVENT (GITLAB_PROJECTS / `*` minus excludes). Everything goes
 * through readConfig, the MCPL server and the real adapter over the fake
 * transport. Project 1 is team/sub/repo, 2 is foreign/repo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { TOOLS_BY_FEATURE_SET } from '../src/types.js';
import type { ToolResult } from '../src/types.js';
import { FakeGitLab, harness, mr, note, PROJECT, SHA } from './harness.js';
const ALL_SETS = Object.keys(TOOLS_BY_FEATURE_SET);
async function setup(vars: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-authority-'));
    const token = join(dir, 'token');
    writeFileSync(token, 'fixture-token', { mode: 0o600 });
    let f: FakeGitLab;
    try {
        f = new FakeGitLab(readConfig({ GITLAB_URL: 'https://gitlab.invalid', GITLAB_TOKEN_FILE: token, ...vars }));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
    f.multi = true;
    await f.init();
    f.mrs = [mr(), mr({ id: 56, iid: 8, project_id: 2, source_project_id: 2, target_project_id: 2 })];
    f.notes = [note({ id: 41, body: 'private note body' })];
    const h = await harness(f);
    await h.initialize();
    await h.grant(undefined, { enabled: ALL_SETS });
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
        try {
            const r = await h.host.sendRequest('tools/call', { name, arguments: args }) as ToolResult;
            return r.isError ? (r.content[0] as { text: string }).text : 'ok';
        }
        catch (e) { return (e as Error).message; }
    };
    // Requests below a project (not the bare `GET /projects/:id` that resolves the canonical id/path a scope decision needs).
    const below = (project: RegExp) => f.calls.filter(c => new RegExp(`^/projects/(?:${project.source})/.+`).test(c.path)).map(c => `${c.method} ${c.path}`);
    const registered = () => h.saw.filter(r => ['channels/register', 'channels/changed'].includes(r.method)).flatMap(r => { const p = r.params as { channels?: { id: string }[]; updated?: { id: string }[] }; return (p.channels ?? p.updated ?? []).map(c => c.id); });
    return { f, h, call, below, registered };
}
const FOREIGN = /2|foreign\/repo/, HOME = /1|team\/sub\/repo/;
type Opened = { channel: { id: string }; history?: { messageId: string; content: unknown }[]; historyTruncated?: boolean };
const HISTORY = { history: { limit: 10 } };
const FORMS = (project: string, iid: number): Record<string, unknown>[] => [{ channelId: `gitlab:${project}!${iid}` }, { type: 'gitlab', address: { project, number: iid, kind: 'mr' } }];
test('channels/open: requested history needs read authority; an event-only open does not (id and address forms)', async () => {
    const modes: [string, Record<string, string>, RegExp][] = [
        ['all-projects', { GITLAB_PROJECTS: '*', GITLAB_READ_ALLOW: PROJECT }, /foreign\/repo is not in GITLAB_READ_ALLOW/],
        // List mode with a read allow narrower than the project list is held to the same rule.
        ['list', { GITLAB_PROJECTS: `${PROJECT},foreign/repo`, GITLAB_READ_ALLOW: PROJECT }, /foreign\/repo is not in GITLAB_READ_ALLOW/],
        // Events-only all-projects mode has no read allow at all: no history anywhere.
        ['all-projects, events only', { GITLAB_PROJECTS: '*', GITLAB_FEATURE_SETS: 'gitlab.events' }, /foreign\/repo is not in GITLAB_READ_ALLOW/],
    ];
    for (const [label, vars, fence] of modes) {
        const { f, h, below, registered } = await setup(vars);
        try {
            // Refused history: by channel id, by numeric project id and by address. Refused before any
            // read below the project and before the channel is registered, so nothing is returned at all.
            for (const form of [...FORMS('foreign/repo', 8), ...FORMS('2', 8)])
                await assert.rejects(h.host.sendRequest('channels/open', { ...form, ...HISTORY }), fence, `${label} ${JSON.stringify(form)}`);
            await assert.rejects(h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8', history: { limit: 1, beforeMessageId: '99' } }), fence, label);
            assert.deepEqual(below(FOREIGN), [], label);
            assert.deepEqual(registered(), [], label);
            // Event-only creation stays allowed, in both forms; limit 0 asks for no content and reads nothing.
            for (const form of FORMS('foreign/repo', 8)) {
                const opened = await h.host.sendRequest('channels/open', form) as Opened;
                assert.equal(opened.channel.id, 'gitlab:foreign/repo!8', label);
                assert.equal(opened.history, undefined, label);
            }
            assert.deepEqual(await h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8', history: { limit: 0 } }), { channel: (await h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8' }) as Opened).channel, history: [], historyTruncated: false }, label);
            assert.deepEqual(registered(), ['gitlab:foreign/repo!8'], label);
            // An existing channel is still no read authority.
            await assert.rejects(h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8', ...HISTORY }), fence, label);
            assert.deepEqual(below(FOREIGN), [], label);
            // Malformed history is refused as such, also where it could not be read anyway.
            await assert.rejects(h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8', history: { limit: -1 } }), /nonnegative integer/, label);
            if (vars.GITLAB_READ_ALLOW) {
                // Positive: history of a read-authorized project is returned, in both forms.
                for (const form of FORMS(PROJECT, 3)) {
                    const opened = await h.host.sendRequest('channels/open', { ...form, ...HISTORY }) as Opened;
                    assert.equal(opened.channel.id, `gitlab:${PROJECT}!3`, label);
                    assert.deepEqual(opened.history!.map(m => m.messageId), ['41'], label);
                    assert.match(JSON.stringify(opened.history), /private note body/, label);
                    assert.equal(opened.historyTruncated, false, label);
                }
                assert.deepEqual([...new Set(below(HOME))], [`GET /projects/${PROJECT}/merge_requests/3/notes`], label);
            }
            assert.ok(!f.calls.some(c => c.method !== 'GET'), label);
            assert.deepEqual(h.violations, [], label);
        }
        finally {
            await h.close();
        }
    }
});
test('channels/open: an explicit read allow authorizes history of a project found through *; an exclude still refuses the channel', async () => {
    for (const allow of ['*', 'foreign/repo', '2', 'foreign/*']) {
        const { h, below } = await setup({ GITLAB_PROJECTS: '*', GITLAB_PROJECTS_EXCLUDE: 'secret/*', GITLAB_READ_ALLOW: allow });
        try {
            for (const form of FORMS('foreign/repo', 8)) {
                const opened = await h.host.sendRequest('channels/open', { ...form, ...HISTORY }) as Opened;
                assert.match(JSON.stringify(opened.history), /private note body/, allow);
            }
            assert.deepEqual([...new Set(below(FOREIGN))], ['GET /projects/foreign/repo/merge_requests/8/notes'], allow);
            // Read authority alone opens nothing: the channel itself is an event-scope object.
            for (const form of FORMS('secret/vault', 9))
                await assert.rejects(h.host.sendRequest('channels/open', { ...form, ...(allow === '*' ? HISTORY : {}) }), /excluded by GITLAB_PROJECTS_EXCLUDE/, allow);
            assert.deepEqual(below(/3|secret\/vault/), [], allow);
        }
        finally {
            await h.close();
        }
    }
});
const TOOL_SETS = { GITLAB_FEATURE_SETS: ALL_SETS.join(','), GITLAB_MERGE_TARGET_ALLOW: `${PROJECT}:main,foreign/repo:main` };
const DISCUSSION = 'd:' + 'd'.repeat(40);
function toolArgs(project: string, iid: number): Record<string, Record<string, unknown>> {
    const thread = `${project}!${iid}`;
    return {
        get_merge_request: { project, iid, include: 'diff,discussions,approvals' }, list_merge_requests: { project }, list_discussions: { thread }, list_pipelines: { project }, get_pipeline: { project, pipeline_id: 10 }, get_job_log: { project, job_id: 5 },
        search_code: { project, query: 'needle' }, get_file: { project, path: 'file.txt', ref: 'main' }, list_tree: { project, ref: 'main' }, get_issue: { project, iid },
        comment: { thread, body: 'hello' }, reply_in_thread: { thread, thread_id: DISCUSSION, body: 'hello' }, edit_own_comment: { thread, note_id: 41, body: 'hello' }, delete_own_comment: { thread, note_id: 41 }, upsert_sticky_comment: { thread, marker: 'status', body: 'hello' },
        create_merge_request: { project, source_branch: 'example-user/topic', target_branch: 'main', title: 'T' }, edit_merge_request: { project, iid, title: 'T' }, request_review: { project, iid, reviewer_id: 8 },
        retry_pipeline: { project, pipeline_id: 10 }, retry_job: { project, job_id: 5 }, rebase_merge_request: { project, iid }, merge_at_sha: { project, iid, sha: SHA },
    };
}
const READ_TOOLS: readonly string[] = TOOLS_BY_FEATURE_SET['gitlab.read'];
test('every tool is fenced by its own authority before any request below the project: reads by READ_ALLOW, writes by WRITE_ALLOW', async () => {
    // foreign/repo is in event scope through *, and in neither allow list.
    const { f, h, call, below, registered } = await setup({ GITLAB_PROJECTS: '*', GITLAB_READ_ALLOW: PROJECT, GITLAB_WRITE_ALLOW: PROJECT, ...TOOL_SETS });
    try {
        const listed = (await h.host.sendRequest('tools/list', {}) as { tools: { name: string }[] }).tools.map(t => t.name).sort();
        assert.deepEqual(listed, Object.keys(toolArgs('x', 1)).sort());
        for (const project of ['foreign/repo', '2'])
            for (const [name, args] of Object.entries(toolArgs(project, 8)))
                assert.match(await call(name, args), READ_TOOLS.includes(name) ? /foreign\/repo is not in GITLAB_READ_ALLOW/ : /foreign\/repo is not in GITLAB_WRITE_ALLOW/, `${name} ${project}`);
        assert.deepEqual(below(FOREIGN), []);
        assert.ok(!f.calls.some(c => c.method !== 'GET'));
        assert.deepEqual(registered(), []);
        // Group search lists the group, then searches only read-authorized projects.
        const r = await h.host.sendRequest('tools/call', { name: 'search_code', arguments: { group: 'team', query: 'needle' } }) as ToolResult;
        assert.notEqual(r.isError, true);
        assert.match(JSON.stringify(r.content), /team\/sub\/repo/);
        assert.doesNotMatch(JSON.stringify(r.content), /foreign/);
        assert.deepEqual(below(FOREIGN), []);
        assert.deepEqual(h.violations, []);
    }
    finally {
        await h.close();
    }
});
test('read and write authority are independent in both directions', async () => {
    // team/sub/repo: writable, not readable. foreign/repo: readable, not writable.
    const { f, h, call, below } = await setup({ GITLAB_PROJECTS: '*', GITLAB_READ_ALLOW: 'foreign/repo', GITLAB_WRITE_ALLOW: PROJECT, ...TOOL_SETS });
    try {
        for (const [name, args] of Object.entries(toolArgs(PROJECT, 3)))
            if (READ_TOOLS.includes(name))
                assert.match(await call(name, args), /team\/sub\/repo is not in GITLAB_READ_ALLOW/, name);
        assert.deepEqual(below(HOME), []);
        await assert.rejects(h.host.sendRequest('channels/open', { channelId: `gitlab:${PROJECT}!3`, ...HISTORY }), /not in GITLAB_READ_ALLOW/);
        assert.deepEqual(below(HOME), []);
        for (const [name, args] of Object.entries(toolArgs('foreign/repo', 8)))
            if (!READ_TOOLS.includes(name))
                assert.match(await call(name, args), /foreign\/repo is not in GITLAB_WRITE_ALLOW/, name);
        assert.deepEqual(below(FOREIGN), []);
        // Positive controls: the read-allowed project is read, the write-allowed project is written.
        assert.equal(await call('get_merge_request', { project: 'foreign/repo', iid: 8 }), 'ok');
        assert.equal(await call('list_discussions', { thread: 'foreign/repo!8' }), 'ok');
        assert.equal(await call('comment', { thread: `${PROJECT}!3`, body: 'hello' }), 'ok');
        assert.deepEqual(f.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`), [`POST /projects/${PROJECT}/merge_requests/3/notes`]);
        // Publication on the channel of a read-only project is still a write.
        await h.host.sendRequest('channels/open', { channelId: 'gitlab:foreign/repo!8' });
        await assert.rejects(h.host.sendRequest('channels/publish', { channelId: 'gitlab:foreign/repo!8', content: [{ type: 'text', text: 'hello' }] }), /not in GITLAB_WRITE_ALLOW/);
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
        // A writable target does not make a foreign source project writable (rebase, edit).
        f.mrs[0].source_project_id = 2;
        for (const name of ['rebase_merge_request', 'edit_merge_request'])
            assert.match(await call(name, toolArgs(PROJECT, 3)[name]), /foreign\/repo is not in GITLAB_WRITE_ALLOW/, name);
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
        assert.deepEqual(h.violations, []);
    }
    finally {
        await h.close();
    }
});
