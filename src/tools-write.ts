import { glob, targetAllowed } from './config.js';
import { GitLabError } from './gitlab-adapter.js';
import { string, integer, boolean, type ToolContext } from './tool-support.js';
import type { MergeRequest, Job, Discussion } from './types.js';
import { neutralize } from './safety.js';
const MR = '/projects/:project/merge_requests/:iid';
export const MERGE_REASONS: Record<string, string> = {
    unchecked: 'GitLab is computing mergeability; retry shortly', checking: 'GitLab is computing mergeability; retry shortly', preparing: 'GitLab is preparing mergeability; retry shortly', approvals_syncing: 'GitLab is synchronizing approvals; retry shortly',
    ci_must_pass: 'The project requires a successful head pipeline', ci_still_running: 'The head pipeline is still running', conflict: 'The MR conflicts with its target; resolve or rebase', need_rebase: 'The project merge method needs a rebase first', draft_status: 'The MR is a Draft; use edit_merge_request draft=false', discussions_not_resolved: 'The project requires all discussions resolved', not_open: 'The MR is closed or already merged', commits_status: 'The source branch is missing or has no commits', locked_lfs_files: 'LFS file locks prevent merge', merge_time: 'A merge schedule constraint prevents merge', not_approved: 'Required approvals are missing', requested_changes: 'Changes have been requested', blocked_status: 'A dependency blocks merge', security_policy_violations: 'A security policy blocks merge',
};
export function mergeReason(mr: MergeRequest): string { return MERGE_REASONS[mr.detailed_merge_status] ?? `GitLab reports ${mr.detailed_merge_status || 'unknown mergeability'}; refusing safely`; }
function branch(a: Record<string, unknown>, key: string): string {
    const b = string(a, key, true, 1000);
    if (/[\r\n\0]/.test(b))
        throw new Error(`${key}: invalid branch`);
    return b;
}
function sourceAllowed(mr: Pick<MergeRequest, 'source_branch'>, project: string, ctx: ToolContext): void {
    const c = ctx.config;
    if (targetAllowed(project, mr.source_branch, c.mrTargetAllow) || (c.sourcePattern && !glob(mr.source_branch, c.sourcePattern)))
        throw new Error(`Source branch ${mr.source_branch} is not allowed by GITLAB_MR_SOURCE_PATTERN / target fence`);
}
export async function writeTool(name: string, a: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const p = await ctx.scope.write(string(a, 'project'));
    const project = p.id;
    const c = ctx.config;
    if (name === 'retry_pipeline' || name === 'retry_job') {
        // GitLab 17.11 completes auto-merge from pipeline completion. Its worker
        // uses all_merge_requests, including cross-project MRs not necessarily
        // visible to this PAT. A visible-MR preflight cannot prove absence, nor
        // atomically prevent a human arming auto-merge after the check.
        throw new Error('CI retry refused: associated-MR auto-merge safety cannot be established on GitLab 17.11; retry outside the connector');
    }
    if (name === 'create_merge_request') {
        const target = branch(a, 'target_branch'), source = branch(a, 'source_branch');
        if (!targetAllowed(p.path_with_namespace, target, c.mrTargetAllow))
            throw new Error(`Target ${target} is not in GITLAB_MR_TARGET_ALLOW`);
        sourceAllowed({ source_branch: source }, p.path_with_namespace, ctx);
        if (c.forceDraft && boolean(a, 'draft') === false)
            throw new Error('GITLAB_MR_FORCE_DRAFT refuses draft=false');
        const title = neutralize(string(a, 'title', true, 1000));
        const draft = c.forceDraft || boolean(a, 'draft') === true;
        const body: Record<string, unknown> = {
            source_branch: source, target_branch: target, title: draft ? `Draft: ${undraft(title)}` : title
        };
        if (a.description !== undefined)
            body.description = neutralize(string(a, 'description', false));
        if (a.labels !== undefined)
            body.labels = string(a, 'labels', false, 4000);
        if (a.remove_source_branch !== undefined)
            body.remove_source_branch = boolean(a, 'remove_source_branch');
        const mr = await ctx.api.request<MergeRequest>('POST', '/projects/:project/merge_requests', { params: { project }, body });
        await ctx.touch?.({
            project: p.path_with_namespace, number: mr.iid, kind: 'mr'
        }, mr.title);
        return mr;
    }
    const iid = integer(a, 'iid');
    const params = { project, iid };
    const mr = await ctx.api.request<MergeRequest>('GET', MR, { params });
    if (name === 'merge_at_sha')
        return merge(a, mr, p.path_with_namespace, ctx);
    if (name === 'rebase_merge_request') {
        const source = await ctx.scope.write(mr.source_project_id);
        sourceAllowed(mr, source.path_with_namespace, ctx);
        if (mr.merge_when_pipeline_succeeds !== false)
            throw new Error('Auto-merge is enabled or unknown; rebase would restart its pipeline, refusing');
        return ctx.api.request('PUT', MR + '/rebase', { params, body: {} });
    }
    const body: Record<string, unknown> = {};
    if (name === 'request_review')
        body.reviewer_ids = [integer(a, 'reviewer_id')]; // Free: exactly one
    else {
        const source = await ctx.scope.write(mr.source_project_id);
        sourceAllowed(mr, source.path_with_namespace, ctx);
        for (const key of ['title', 'description', 'labels'])
            if (a[key] !== undefined)
                body[key] = neutralize(string(a, key, key === 'title', key === 'title' ? 1000 : 200000));
        if (a.target_branch !== undefined) {
            const target = branch(a, 'target_branch');
            if (!targetAllowed(p.path_with_namespace, target, c.mrTargetAllow))
                throw new Error(`Target ${target} is not in GITLAB_MR_TARGET_ALLOW`);
            body.target_branch = target;
        }
        const draft = boolean(a, 'draft');
        if (draft === false && c.forceDraft)
            throw new Error('GITLAB_MR_FORCE_DRAFT refuses draft=false');
        if (draft !== undefined)
            body.title = draft ? `Draft: ${undraft(String(body.title ?? mr.title))}` : undraft(String(body.title ?? mr.title));
        // A title edit must not bypass force-draft.
        if (c.forceDraft && body.title !== undefined)
            body.title = `Draft: ${undraft(String(body.title))}`;
        if (a.remove_source_branch !== undefined)
            body.remove_source_branch = boolean(a, 'remove_source_branch');
        if (!Object.keys(body).length)
            throw new Error('No MR fields supplied');
    }
    const result = await ctx.api.request<MergeRequest>('PUT', MR, { params, body });
    await ctx.touch?.({
        project: p.path_with_namespace, number: iid, kind: 'mr'
    }, result.title);
    return result;
}
function undraft(title: string): string { return title.replace(/^(?:(?:draft|wip):\s*|\[(?:draft|wip)\]\s*|\((?:draft|wip)\)\s*)+/i, ''); }
async function merge(a: Record<string, unknown>, mr: MergeRequest, project: string, ctx: ToolContext): Promise<unknown> {
    const sha = string(a, 'sha');
    if (!/^[0-9a-f]{40}$/i.test(sha))
        throw new Error('sha: requires a full 40-hex SHA');
    const { config: c } = ctx;
    const params = { project, iid: mr.iid };
    let outcome = 'refused';
    let mergeSha: string | null | undefined;
    const refuse = (reason: string): never => { throw new Error(`merge_at_sha refused: ${reason}`); };
    try {
        if (!targetAllowed(project, mr.target_branch, c.mergeTargetAllow))
            refuse(`target ${mr.target_branch} is not in GITLAB_MERGE_TARGET_ALLOW`);
        if (c.mergeAuthorOnly && mr.author.id !== ctx.user.id)
            refuse(`only MRs authored by ${ctx.user.username} may be merged`);
        if (sha.toLowerCase() !== mr.sha.toLowerCase())
            refuse(`head moved: requested ${sha}; current head ${mr.sha} (updated ${mr.updated_at})`);
        if (mr.merge_when_pipeline_succeeds !== false)
            refuse('auto-merge is set or unknown; not interfering');
        if (mr.state !== 'opened')
            refuse('MR is closed or already merged');
        if (c.mergeRequirePipeline && (!mr.head_pipeline || mr.head_pipeline.sha !== mr.sha || mr.head_pipeline.status !== 'success')) {
            let failed: unknown[] = [];
            if (mr.head_pipeline?.status === 'failed')
                failed = await ctx.api.list<Job>('/projects/:project/pipelines/:pipeline/jobs', { params: { project, pipeline: mr.head_pipeline.id }, query: { 'scope[]': 'failed' } }).then(j => j.map(x => ({ id: x.id, name: x.name })));
            refuse(`head pipeline #${mr.head_pipeline?.id ?? 'missing'} for ${mr.head_pipeline?.sha ?? 'unknown'} is ${mr.head_pipeline?.status ?? 'missing'}; failed jobs: ${JSON.stringify(failed)}`);
        }
        if (mr.draft || mr.detailed_merge_status !== 'mergeable') {
            let extra = '';
            if (mr.detailed_merge_status === 'discussions_not_resolved') {
                const d = await ctx.api.list<Discussion>(MR + '/discussions', { params });
                extra = ` (${d.filter(x => x.notes.some(n => n.resolvable && !n.resolved)).length} unresolved discussions)`;
            }
            refuse((mr.draft ? 'MR is a Draft' : mergeReason(mr)) + extra);
        }
        // Persist intent before irreversible write. No rollback and no retry.
        ctx.logger.info('merge audit', {
            tool: 'merge_at_sha', project, iid: mr.iid, sha, outcome: 'attempt'
        });
        ctx.state.audit({
            tool: 'merge_at_sha', project, iid: mr.iid, sha, outcome: 'attempt'
        });
        await ctx.state.flush();
        let result: MergeRequest;
        try {
            result = await ctx.api.request<MergeRequest>('PUT', MR + '/merge', { params, body: { sha, ...(c.mergeRemoveSource ? { should_remove_source_branch: true } : {}) } });
        }
        catch (e) {
            if (e instanceof GitLabError) {
                if (e.status === 401 || e.status === 403)
                    refuse(`account may not merge into ${mr.target_branch}; check protected-branch permissions`);
                if ([405, 409, 422].includes(e.status)) {
                    const fresh = await ctx.api.request<MergeRequest>('GET', MR, { params });
                    refuse(e.status === 409 ? `head moved after pre-flight; current head ${fresh.sha}` : `${e.status === 422 ? 'Branch cannot be merged: ' : ''}${mergeReason(fresh)}; ${fresh.merge_error ?? ''}`);
                }
            }
            outcome = 'unknown';
            throw e;
        }
        if (result.state !== 'merged') {
            outcome = 'unknown';
            throw new Error('Merge returned without merged state; inspect MR, do not blindly retry');
        }
        outcome = 'merged';
        mergeSha = result.merge_commit_sha ?? result.squash_commit_sha;
        await ctx.onEvent?.({
            id: `mr.merged:${project}:${mr.iid}:${mergeSha ?? sha}`, kind: 'mr.merged', project, thread: {
                project, number: mr.iid, kind: 'mr'
            }, actor: ctx.user, receivedAt: new Date().toISOString(), sha: mergeSha ?? sha, own: mr.author.id === ctx.user.id, data: { merge_commit_sha: result.merge_commit_sha, squash_commit_sha: result.squash_commit_sha }
        });
        return {
            state: 'merged', merge_commit_sha: result.merge_commit_sha, squash_commit_sha: result.squash_commit_sha
        };
    }
    finally {
        const entry = {
            tool: 'merge_at_sha', project, iid: mr.iid, sha, outcome, merge_sha: mergeSha
        };
        ctx.logger.info('merge audit', entry);
        ctx.state.audit(entry);
        try {
            await ctx.state.flush();
        }
        catch {
            ctx.logger.error('Merge audit persistence failed', entry);
            if (outcome === 'merged')
                throw new Error(`Merge succeeded (${mergeSha}), but audit could not be persisted`);
        }
    }
}
