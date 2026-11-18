import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeGitLab, config, mr, note, PROJECT, SHA, SHA2 } from './harness.js';
import { callTool } from '../src/tools.js';
import { rollbackComments } from '../src/tools-comments.js';
import { MERGE_REASONS } from '../src/tools-write.js';
import type { Config } from '../src/config.js';
const writes: Partial<Config> = {
    featureSets: [
        'gitlab.read', 'gitlab.comments', 'gitlab.mr', 'gitlab.ci', 'gitlab.rebase', 'gitlab.merge'
    ], mrTargetAllow: ['main'], sourcePattern: 'example-user/*', mergeTargetAllow: ['main']
};
const text = (r: {
    content: unknown[];
}) => JSON.stringify(r.content);
async function call(f: FakeGitLab, name: string, args: Record<string, unknown>) { return callTool(name, args, f.ctx); }
test('one-call MR returns metadata, bounded diffs, discussions, approvals; no deprecated /changes', async () => {
    const f = await new FakeGitLab(config({ diffMax: 9, diffFileMax: 9 })).init();
    const r = await call(f, 'get_merge_request', { project: PROJECT, iid: 3, include: 'diff,discussions,approvals' });
    assert.ok(!r.isError);
    assert.match(text(r), /truncated_files/);
    assert.match(text(r), /head_pipeline/);
    assert.ok(!f.calls.some(c => c.path.endsWith('/changes')));
});
test('read tools cover pipelines, jobs, bounded log literal grep, files and trees', async () => {
    const f = await new FakeGitLab(config({ logMax: 12, fileMax: 3 })).init();
    f.pipelines = [mr().head_pipeline!];
    for (const [name, args] of Object.entries({
        list_merge_requests: { project: PROJECT, draft: false }, list_pipelines: { project: PROJECT }, get_pipeline: { project: PROJECT, pipeline_id: 10 }, get_issue: { project: PROJECT, iid: 3 }, list_tree: { project: PROJECT, ref: 'main' }, list_discussions: { thread: `${PROJECT}!3` }
    })) {
        assert.ok(!(await call(f, name, args)).isError, name);
    }
    const log = await call(f, 'get_job_log', {
        project: PROJECT, job_id: 1, grep: 'error', context: 0
    });
    assert.ok(!log.isError);
    assert.equal(f.calls.at(-1)!.tailBytes, 12);
    const file = await call(f, 'get_file', {
        project: PROJECT, path: 'dir/a.txt', ref: 'main'
    });
    assert.match(text(file), /hel/);
    assert.match(text(file), /truncated/);
    assert.equal((await call(f, 'get_job_log', {
        project: PROJECT, job_id: 1, max_bytes: 13
    })).isError, true);
});
test('Free group search fans out per project and is capped/read-fenced', async () => {
    const f = await new FakeGitLab(config({ readAllow: ['*'], searchMax: 1 })).init();
    const r = await call(f, 'search_code', { group: 'team', query: 'needle' });
    assert.ok(!r.isError);
    assert.equal(f.calls.filter(c => c.path.endsWith('/search')).length, 1);
    assert.ok(!f.calls.some(c => c.path.includes('/groups/') && c.path.endsWith('/search')));
    assert.match(text(r), /truncated/);
});
test('comment ownership, reply routing, sticky upsert, rollback create/edit and undeletable receipts', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    const checkpoint = f.state.createCheckpoint();
    f.notes = [note({
            id: 77, author: { id: 7, username: 'renamed' }, body: 'old'
        })];
    assert.ok(!(await call(f, 'edit_own_comment', {
        thread: `${PROJECT}!3`, note_id: 77, body: '/merge'
    })).isError);
    assert.equal(f.notes[0].body, '/\u200bmerge');
    assert.ok(!(await call(f, 'reply_in_thread', {
        thread: `${PROJECT}!3`, thread_id: 'd:' + 'd'.repeat(40), body: 'reply'
    })).isError);
    assert.ok(f.calls.some(c => c.path.endsWith('/discussions/' + 'd'.repeat(40) + '/notes')));
    for (const body of ['one', 'two'])
        assert.ok(!(await call(f, 'upsert_sticky_comment', {
            thread: `${PROJECT}!3`, marker: 'status', body
        })).isError);
    assert.equal(f.notes.filter(n => n.body.includes('gitlab-mcpl:status')).length, 1);
    const receipt = await rollbackComments(checkpoint.id, f.ctx) as {
        success: boolean;
    };
    assert.equal(receipt.success, true);
    assert.deepEqual(f.notes.map(n => [n.id, n.body]), [[77, 'old']]);
    f.notes.push(note({ id: 88 }));
    assert.equal((await call(f, 'delete_own_comment', { thread: `${PROJECT}!3`, note_id: 88 })).isError, true);
    assert.ok(!(await call(f, 'delete_own_comment', { thread: `${PROJECT}!3`, note_id: 77 })).isError);
    assert.equal((await rollbackComments(checkpoint.id, f.ctx) as {
        success: boolean;
    }).success, false);
});
test('rollback retries failed undo, refuses foreign projects and neutralises legacy text', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    const cp = f.state.createCheckpoint();
    f.notes = [note({
            id: 77, author: { id: 7, username: 'self' }, body: 'current'
        })];
    f.state.recordEditedComment({
        repo: PROJECT, commentId: 77, review: false, thread: { kind: 'mr', number: 3 }, previousBody: '/merge'
    });
    let fail = true;
    f.override = c => c.method === 'PUT' && fail ? {
        status: 500, headers: {}, text: '{}'
    } : undefined;
    assert.equal((await rollbackComments(cp.id, f.ctx) as {
        success: boolean;
    }).success, false);
    fail = false;
    assert.equal((await rollbackComments(cp.id, f.ctx) as {
        success: boolean;
    }).success, true);
    assert.equal(f.notes[0].body, '/\u200bmerge');
});
test('MR fields, force-draft, source and target fences, and one reviewer', async () => {
    const f = await new FakeGitLab(config({ ...writes, forceDraft: true })).init();
    const create = {
        project: PROJECT, source_branch: 'example-user/new', target_branch: 'main', title: 'hello', description: '/merge'
    };
    assert.ok(!(await call(f, 'create_merge_request', create)).isError);
    assert.equal(f.calls.at(-1)!.body.title, 'Draft: hello');
    assert.equal(f.calls.at(-1)!.body.description, '/\u200bmerge');
    for (const extra of [{ auto_merge: true }, { state_event: 'merge' }, { draft: false }, { target_branch: 'prod' }, { source_branch: 'other/topic' }])
        assert.equal((await call(f, 'create_merge_request', { ...create, ...extra })).isError, true);
    assert.equal((await call(f, 'edit_merge_request', {
        project: PROJECT, iid: 3, draft: false
    })).isError, true);
    assert.ok(!(await call(f, 'edit_merge_request', {
        project: PROJECT, iid: 3, title: 'not draft'
    })).isError);
    assert.equal(f.calls.at(-1)!.body.title, 'Draft: not draft');
    assert.ok(!(await call(f, 'request_review', {
        project: PROJECT, iid: 3, reviewer_id: 99
    })).isError);
    assert.deepEqual(f.calls.at(-1)!.body, { reviewer_ids: [99] });
});
test('undraft 17.11 uses title rather than unsupported draft param', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    f.mrs = [mr({ title: 'Draft: WIP: work', draft: true })];
    assert.ok(!(await call(f, 'edit_merge_request', {
        project: PROJECT, iid: 3, draft: false
    })).isError);
    assert.deepEqual(f.calls.at(-1)!.body, { title: 'work' });
});
test('CI retries fail closed even with allowed refs and no merge capability', async () => {
    const f = await new FakeGitLab(config({ ...writes, featureSets: ['gitlab.ci'] })).init();
    for (const armed of [true, false, undefined]) {
        f.mrs = [mr({ merge_when_pipeline_succeeds: armed })];
        for (const ref of ['main', 'example-user/topic', 'refs/merge-requests/3/head']) {
            f.config.retryRefs = [ref];
            f.jobs = [{ id: 1, name: 'test', ref, status: 'failed', stage: 'test' }];
            for (const name of ['retry_job', 'retry_pipeline']) {
                const result = await call(f, name, { project: PROJECT, [name === 'retry_job' ? 'job_id' : 'pipeline_id']: 1 });
                assert.equal(result.isError, true);
                assert.match(text(result), /auto-merge safety cannot be established/);
            }
        }
    }
    assert.ok(!f.calls.some(c => c.method !== 'GET'));
});
test('rebase guards foreign source, branch mismatch and enabled/unknown auto-merge', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    for (const change of [{ source_project_id: 2 }, { source_branch: 'main' }, { merge_when_pipeline_succeeds: true }, { merge_when_pipeline_succeeds: undefined }]) {
        f.mrs = [mr(change)];
        assert.equal((await call(f, 'rebase_merge_request', { project: PROJECT, iid: 3 })).isError, true);
    }
    f.mrs = [mr()];
    assert.ok(!(await call(f, 'rebase_merge_request', { project: PROJECT, iid: 3 })).isError);
    assert.deepEqual(f.calls.at(-1)!.body, {});
});
for (const status of Object.keys(MERGE_REASONS))
    test(`merge refusal explains ${status} without a write`, async () => {
        const f = await new FakeGitLab(config(writes)).init();
        f.mrs = [mr({ detailed_merge_status: status })];
        const r = await call(f, 'merge_at_sha', {
            project: PROJECT, iid: 3, sha: SHA
        });
        assert.equal(r.isError, true);
        assert.match(text(r), /refused/);
        assert.ok(!f.calls.some(c => c.method === 'PUT'));
    });
test('merge checks exact SHA/author/target/pipeline/auto-merge; no retry; minimal body and self event', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    const args = {
        project: PROJECT, iid: 3, sha: SHA
    };
    for (const change of [
        { sha: SHA2 }, { author: { id: 8, username: 'human' } }, { target_branch: 'prod' }, { head_pipeline: null }, { head_pipeline: {
                id: 1, sha: SHA2, ref: 'x', status: 'success'
            } }, { head_pipeline: {
                id: 1, sha: SHA, ref: 'x', status: 'running'
            } }, { merge_when_pipeline_succeeds: true }
    ]) {
        f.mrs = [mr(change)];
        assert.equal((await call(f, 'merge_at_sha', args)).isError, true);
    }
    f.mrs = [mr()];
    let event;
    f.ctx.onEvent = async (e) => { event = e; return true; };
    assert.ok(!(await call(f, 'merge_at_sha', args)).isError);
    assert.deepEqual(f.calls.find(c => c.path.endsWith('/merge'))!.body, { sha: SHA });
    assert.ok(event);
    assert.equal(f.state.snapshot().audit.at(-1)!.outcome, 'merged');
});
for (const status of [401, 405, 409, 422])
    test(`merge ${status} mapped, reread when appropriate, never retried`, async () => {
        const f = await new FakeGitLab(config(writes)).init();
        f.override = c => c.path.endsWith('/merge') ? {
            status, headers: {}, text: '{}'
        } : undefined;
        const r = await call(f, 'merge_at_sha', {
            project: PROJECT, iid: 3, sha: SHA
        });
        assert.equal(r.isError, true);
        assert.equal(f.calls.filter(c => c.path.endsWith('/merge')).length, 1);
        assert.ok(f.calls.filter(c => c.path.endsWith('/merge_requests/3')).length === (status === 401 ? 1 : 2));
    });
test('rollback retains original durable journal during remote undo', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    const cp = f.state.createCheckpoint();
    f.notes = [note({ id: 77, author: { id: 7, username: 'self' } })];
    f.state.recordCreatedComment({
        repo: PROJECT, commentId: 77, review: false, thread: { kind: 'mr', number: 3 }
    });
    f.override = c => {
        if (c.method === 'DELETE')
            assert.equal(f.state.snapshot().created[cp.id].length, 1);
        return undefined;
    };
    await rollbackComments(cp.id, f.ctx);
    assert.equal(f.state.snapshot().created[cp.id], undefined);
});
test('multiple edits rollback to oldest body, even after a failed restore and retry', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    const cp = f.state.createCheckpoint();
    f.notes = [note({
            id: 77, author: { id: 7, username: 'self' }, body: 'A'
        })];
    for (const body of ['B', 'C'])
        assert.ok(!(await call(f, 'edit_own_comment', {
            thread: `${PROJECT}!3`, note_id: 77, body
        })).isError);
    let fail = true;
    f.override = c => c.method === 'PUT' && fail ? {
        status: 500, headers: {}, text: '{}'
    } : undefined;
    assert.equal((await rollbackComments(cp.id, f.ctx) as {
        success: boolean;
    }).success, false);
    fail = false;
    assert.equal((await rollbackComments(cp.id, f.ctx) as {
        success: boolean;
    }).success, true);
    assert.equal(f.notes[0].body, 'A');
});

test('rollback strips CR before neutralizing the saved original body', async () => {
    const f = await new FakeGitLab(config(writes)).init();
    const checkpoint = f.state.createCheckpoint();
    f.notes = [note({ id: 77, author: f.ctx.user, body: '/\rrebase' })];
    assert.ok(!(await call(f, 'edit_own_comment', { thread: `${PROJECT}!3`, note_id: 77, body: 'replacement' })).isError);
    await rollbackComments(checkpoint.id, f.ctx);
    assert.equal(f.notes[0].body, '/\u200brebase');
});

function data(r: Awaited<ReturnType<typeof callTool>>) {
    assert.ok(!r.isError, text(r));
    return JSON.parse((r.content[0] as { text: string }).text.split('\n').slice(1).join('\n'));
}
test('read lists use one bounded page, compact users, and explicit expansion', async () => {
    const f = await new FakeGitLab().init();
    f.override = c => /\/(merge_requests|pipelines|jobs)$/.test(c.path) ? {
        status: 200, headers: { 'x-next-page': '2' }, text: JSON.stringify(Array.from({ length: Number(c.url.searchParams.get('per_page')) }, (_, id) => ({
            id, title: 'work', sha: SHA, ref: 'main', status: 'failed', failure_reason: 'script_failure',
            user: { id: 7, username: 'agent', avatar_url: 'x'.repeat(10000) }, unused: 'bulk'
        })))
    } : undefined;
    for (const name of ['list_merge_requests', 'list_pipelines', 'get_pipeline']) {
        const before = f.calls.length;
        const r = data(await call(f, name, { project: PROJECT, ...(name === 'get_pipeline' ? { pipeline_id: 10 } : {}) }));
        const page = name === 'get_pipeline' ? r.jobs : r;
        assert.equal(page.items.length, 20);
        assert.equal(page.next_page, 2);
        assert.equal(page.items[0].user.avatar_url, undefined);
        assert.equal(page.items[0].failure_reason, 'script_failure');
        assert.ok(JSON.stringify(r).length < 12000);
        assert.equal(f.calls.length - before, name === 'get_pipeline' ? 2 : 1);
    }
    const more = data(await call(f, 'list_pipelines', { project: PROJECT, page: 2, limit: 1, full: true }));
    assert.equal(more.items[0].unused, 'bulk');
    assert.equal(more.output_truncated, true);
    assert.equal(f.calls.at(-1)!.url.searchParams.get('page'), '2');
    assert.equal(f.calls.at(-1)!.url.searchParams.get('per_page'), '1');
    assert.equal((await call(f, 'list_pipelines', { project: PROJECT, limit: 101 })).isError, true);
    f.override = undefined;
    const before = f.calls.length;
    data(await call(f, 'get_merge_request', { project: PROJECT, iid: 3 }));
    assert.equal(f.calls.length - before, 1);
});
test('group 404 explains user namespaces without hiding other errors', async () => {
    const f = await new FakeGitLab().init();
    for (const status of [404, 403]) {
        f.override = c => c.path.startsWith('/groups/') ? { status, headers: {}, text: '{}' } : undefined;
        const r = await call(f, 'search_code', { group: 'group', query: 'needle' });
        assert.equal(r.isError, true);
        assert.match(text(r), status === 404 ? /user namespace.*username\/repository/ : /403/);
        assert.ok(!f.calls.some(c => c.path.endsWith('/search')));
    }
});
test('job log strips ANSI and section markers before literal grep and keeps headings', async () => {
    const f = await new FakeGitLab().init();
    f.override = c => c.path.endsWith('/trace') ? { status: 200, headers: {}, text:
        '\x1b[0Ksection_start:123:build[collapsed=true]\r\x1b[0KBuild heading\n\x1b[31merror\x1b[0m message\n\x1b[0Ksection_end:124:build\r\x1b[0K\nDone' } : undefined;
    const args = { project: PROJECT, job_id: 1 };
    assert.equal(data(await call(f, 'get_job_log', args)).text, 'Build heading\nerror message\n\nDone');
    assert.equal(data(await call(f, 'get_job_log', { ...args, grep: 'error message', context: 0 })).text, '2: error message');
});
