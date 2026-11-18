// Port of github-mcpl's ownership/sticky/checkpoint rollback algorithm; GitLab
// uses a single note id space and requires the noteable iid on every operation.
import { McplRpcError } from './errors.js';
import { GitLabError } from './gitlab-adapter.js';
import type { Note } from './types.js';
import { channelId } from './types.js';
import { base, params, string, integer, thread, type ToolContext } from './tool-support.js';
import type { CreatedCommentRecord, EditedCommentRecord } from './state.js';
import { neutralize } from './safety.js';
export async function commentsTool(name: string, a: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const t = await thread(a, ctx);
    const path = base(t);
    const opt = { params: params(t) };
    let body = name === 'delete_own_comment' ? '' : neutralize(string(a, 'body'));
    let note: Note | undefined;
    if (name === 'upsert_sticky_comment') {
        const marker = string(a, 'marker', true, 100);
        if (!/^[\w.-]+$/.test(marker))
            throw new Error('marker: use a simple key (letters, digits, underscore, dot, dash)');
        const mark = `<!-- gitlab-mcpl:${marker} -->`;
        body = mark + '\n' + body;
        note = (await ctx.api.list<Note>(path + '/notes', opt)).find(n => n.author.id === ctx.user.id && n.body.startsWith(mark + '\n'));
    }
    if (name === 'edit_own_comment' || name === 'delete_own_comment')
        note = await ctx.api.request<Note>('GET', path + '/notes/:note', { params: { ...opt.params, note: integer(a, 'note_id') } });
    if (note && note.author.id !== ctx.user.id)
        throw new Error(`Note ${note.id} is not authored by numeric user ${ctx.user.id}`);
    const record = {
        repo: t.project, commentId: note?.id ?? 0, review: false, thread: { number: t.number, kind: t.kind }
    };
    if (name === 'delete_own_comment') {
        await ctx.api.request('DELETE', path + '/notes/:note', { params: { ...opt.params, note: note!.id } });
        ctx.state.recordDeletedComment({ ...record, previousBody: note!.body });
    }
    else if (note) {
        await ctx.api.request('PUT', path + '/notes/:note', { params: { ...opt.params, note: note.id }, body: { body } });
        ctx.state.recordEditedComment({ ...record, previousBody: note.body });
    }
    else {
        let endpoint = path + '/notes';
        let p = opt.params;
        if (name === 'reply_in_thread') {
            const did = string(a, 'thread_id');
            if (!/^d:[a-f0-9]{40}$/.test(did))
                throw new Error('thread_id: expected d:<40-hex discussion id>');
            endpoint = path + '/discussions/:discussion/notes';
            p = { ...p, discussion: did.slice(2) };
        }
        note = await ctx.api.request<Note>('POST', endpoint, { params: p, body: { body } });
        if (!note || !Number.isSafeInteger(note.id))
            throw new Error('GitLab write returned no note id; outcome uncertain, inspect before retrying');
        ctx.state.recordCreatedComment({ ...record, commentId: note.id });
    }
    // Persist side-effect bookkeeping before channel operations that can fail.
    try {
        await ctx.state.flush();
    }
    catch {
        throw new Error(`Write succeeded (note ${note?.id}), but rollback bookkeeping could not be persisted`);
    }
    await ctx.touch?.(t);
    return {
        channel: channelId(t), note_id: note?.id, action: name, undoable: name !== 'delete_own_comment'
    };
}
export async function rollbackComments(checkpoint: string, ctx: ToolContext): Promise<unknown> {
    const plan = ctx.state.previewRollback(checkpoint);
    if (!plan)
        throw new McplRpcError(-32005, `Unknown or abandoned checkpoint: ${checkpoint}`);
    const pendingCreated: CreatedCommentRecord[] = [], pendingEdited: EditedCommentRecord[] = [];
    const undone: string[] = [], failed: string[] = [], cannotUndo: string[] = [];
    const created = new Set(plan.created.map(r => `${r.repo}:${r.commentId}`));
    const deleted = new Set(plan.deleted.map(r => `${r.repo}:${r.commentId}`));
    const undo = async (r: CreatedCommentRecord | EditedCommentRecord, edit: boolean) => {
        try {
            const project = await ctx.scope.write(r.repo);
            if (!r.thread)
                throw new Error('Missing noteable locator');
            const t = { project: project.path_with_namespace, ...r.thread };
            const p = { ...params(t), note: r.commentId };
            const path = base(t) + '/notes/:note';
            let note: Note;
            try {
                note = await ctx.api.request<Note>('GET', path, { params: p });
            }
            catch (e) {
                if (!edit && e instanceof GitLabError && e.status === 404) {
                    undone.push(`already absent ${r.commentId}`);
                    return;
                }
                throw e;
            }
            if (note.author.id !== ctx.user.id)
                throw new Error('Note owner changed; refused');
            await ctx.api.request(edit ? 'PUT' : 'DELETE', path, { params: p, ...(edit ? { body: { body: neutralize((r as EditedCommentRecord).previousBody) } } : {}) });
            undone.push(`${edit ? 'restored' : 'deleted'} ${r.commentId}`);
        }
        catch {
            failed.push(`Could not ${edit ? 'restore' : 'delete'} ${r.repo} note ${r.commentId}`);
            if (edit)
                pendingEdited.push(r as EditedCommentRecord);
            else
                pendingCreated.push(r);
        }
    };
    for (const r of plan.created)
        await undo(r, false);
    // One restore per note, to its OLDEST pre-checkpoint body. Applying each
    // intermediate edit separately could restore an older body successfully,
    // then retry a failed newer restore and move away from the checkpoint.
    const restores = new Map<string, EditedCommentRecord>();
    for (const r of plan.edited)
        restores.set(`${r.repo}:${r.commentId}`, r);
    for (const r of restores.values())
        if (!created.has(`${r.repo}:${r.commentId}`) && !deleted.has(`${r.repo}:${r.commentId}`))
            await undo(r, true);
    for (const r of plan.deleted)
        cannotUndo.push(`Deleted note ${r.repo}:${r.commentId} cannot be undeleted`);
    ctx.state.rollback(checkpoint);
    for (const r of pendingCreated)
        ctx.state.recordCreatedComment(r);
    for (const r of pendingEdited)
        ctx.state.recordEditedComment(r);
    for (const r of plan.deleted)
        ctx.state.recordDeletedComment(r);
    await ctx.state.flush();
    return {
        checkpoint, undone, failed, cannotUndo, success: failed.length === 0 && cannotUndo.length === 0
    };
}
