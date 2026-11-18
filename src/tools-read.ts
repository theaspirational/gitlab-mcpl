import { stripVTControlCharacters } from 'node:util';
import { GitLabError, type RequestOptions } from './gitlab-adapter.js';
import { readOutput } from './read-output.js';
import type { ToolContext } from './tool-support.js';
import { integer, string, thread, base, params } from './tool-support.js';
import type { Diff, MergeRequest, Project, Pipeline } from './types.js';
import { bound } from './safety.js';
export async function readTool(name: string, a: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { api, config: c } = ctx;
    if (name === 'list_discussions') {
        const t = await thread(a, ctx, false);
        await ctx.touch?.(t);
        return page(base(t) + '/discussions', { params: params(t) });
    }
    if (name === 'search_code' && a.group !== undefined) {
        if (a.project !== undefined)
            throw new Error('search_code: choose project OR group');
        const group = string(a, 'group');
        // Never use unsupported group blob search on Free; filter each resolved
        // project's canonical path BEFORE any search. Count all pages for honesty.
        let projects: Project[];
        try { projects = await api.list<Project>('/groups/:group/projects', { params: { group }, query: { include_subgroups: true, with_shared: false } }); }
        catch (error) {
            if (error instanceof GitLabError && error.status === 404)
                throw new Error('search_code: group must be an accessible GitLab group, not a user namespace. Group missing or inaccessible; for user-owned repositories use project="username/repository".');
            throw error;
        }
        const allowed: Project[] = [];
        for (const p of projects) {
            try {
                allowed.push(await ctx.scope.read(p.id));
            }
            catch { /* unreadable or outside read scope */ }
        }
        const results = [];
        for (const p of allowed.slice(0, c.searchMax))
            results.push({ project: p.path_with_namespace, hits: await search(p.id) });
        return {
            results, searched: results.length, eligible: allowed.length, truncated: allowed.length > c.searchMax
        };
    }
    const p = await ctx.scope.read(string(a, 'project'));
    const project = p.id;
    switch (name) {
        case 'get_merge_request': {
            const iid = integer(a, 'iid');
            const opt = { params: { project, iid } };
            const mr = await api.request<MergeRequest>('GET', '/projects/:project/merge_requests/:iid', opt);
            const include = a.include === undefined ? [] : string(a, 'include', false).split(',').map(s => s.trim()).filter(Boolean);
            if (include.some(x => !['diff', 'discussions', 'approvals'].includes(x)))
                throw new Error('include: expected comma-separated diff,discussions,approvals');
            const result: Record<string, unknown> = { ...readOutput(mr, a.full === true) };
            if (include.includes('diff')) {
                const diffPage = await page('/projects/:project/merge_requests/:iid/diffs', opt);
                const diffs = diffPage.items as Diff[];
                result.diffs_page = { page: diffPage.page, next_page: diffPage.next_page };
                result.output_truncated ||= diffPage.output_truncated;
                let remaining = c.diffMax;
                const truncated: string[] = [];
                result.diffs = diffs.map(d => {
                    const text = bound(d.diff ?? '', Math.min(remaining, c.diffFileMax, 200000));
                    remaining -= Buffer.byteLength(text);
                    if (text !== (d.diff ?? '') || d.too_large || d.collapsed)
                        truncated.push(d.new_path);
                    return { ...d, diff: text };
                });
                result.truncated_files = truncated;
            }
            if (include.includes('discussions'))
                result.discussions = await page('/projects/:project/merge_requests/:iid/discussions', opt);
            if (include.includes('approvals'))
                result.approvals = readOutput(await api.request('GET', '/projects/:project/merge_requests/:iid/approvals', opt), a.full === true);
            await ctx.touch?.({
                project: p.path_with_namespace, number: iid, kind: 'mr'
            }, mr.title);
            return result;
        }
        case 'get_issue': {
            const iid = integer(a, 'iid');
            const result = await api.request('GET', '/projects/:project/issues/:iid', { params: { project, iid } });
            await ctx.touch?.({
                project: p.path_with_namespace, number: iid, kind: 'issue'
            });
            return readOutput(result, a.full === true);
        }
        case 'list_merge_requests': {
            const state = a.state === undefined ? 'opened' : string(a, 'state');
            if (!['opened', 'closed', 'merged', 'all'].includes(state))
                throw new Error('state: opened, closed, merged or all');
            const draft = a.draft;
            if (draft !== undefined && typeof draft !== 'boolean')
                throw new Error('draft: expected boolean');
            return page('/projects/:project/merge_requests', { params: { project }, query: {
                    state, author_id: a.author_id === undefined ? undefined : integer(a, 'author_id'), reviewer_username: string(a, 'reviewer', false) || undefined, wip: draft === undefined ? undefined : draft ? 'yes' : 'no'
                } });
        }
        case 'list_pipelines': {
            const opt = { params: { project, ...(a.iid === undefined ? {} : { iid: integer(a, 'iid') }) }, query: { sha: string(a, 'sha', false) || undefined, ref: string(a, 'ref', false) || undefined } };
            const rows = await page(a.iid === undefined ? '/projects/:project/pipelines' : '/projects/:project/merge_requests/:iid/pipelines', opt);
            return { ...rows, items: (rows.items as Pipeline[]).filter(p => (!opt.query.sha || p.sha === opt.query.sha) && (!opt.query.ref || p.ref === opt.query.ref)) };
        }
        case 'get_pipeline': {
            const opt = { params: { project, pipeline: integer(a, 'pipeline_id') } };
            return { pipeline: readOutput(await api.request('GET', '/projects/:project/pipelines/:pipeline', opt), a.full === true), jobs: await page('/projects/:project/pipelines/:pipeline/jobs', opt) };
        }
        case 'get_job_log': {
            const max = Math.min(200000, a.max_bytes === undefined ? c.logMax : integer(a, 'max_bytes', 1, c.logMax));
            const text = await api.request<string>('GET', '/projects/:project/jobs/:job/trace', { params: { project, job: integer(a, 'job_id') }, tailBytes: max });
            const rawTail = bound(text, max, true);
            const tail = stripVTControlCharacters(rawTail).replace(/section_(?:start|end):\d+:[^\r\n]*\r/g, '').replace(/\r/g, '');
            const grep = string(a, 'grep', false, 1000);
            if (!grep)
                return {
                    text: tail, tail_bytes: max, possibly_truncated: Buffer.byteLength(rawTail) >= max - 3
                };
            const context = a.context === undefined ? 2 : integer(a, 'context', 0, 20);
            const lines = tail.split('\n');
            const selected = new Set<number>();
            for (let i = 0; i < lines.length; i++)
                if (lines[i].includes(grep))
                    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
                        selected.add(j);
            return {
                text: [...selected].map(i => `${i + 1}: ${lines[i]}`).join('\n'), grep, literal: true, tail_bytes: max
            };
        }
        case 'search_code': return search(project);
        case 'get_file': {
            const file = await api.request<{
                content: string;
                encoding: string;
                size: number;
            }>('GET', '/projects/:project/repository/files/:file', { params: { project, file: string(a, 'path') }, query: { ref: string(a, 'ref') } });
            if (file.encoding !== 'base64')
                throw new Error('Unsupported file encoding');
            const data = Buffer.from(file.content, 'base64');
            return {
                ...file, content: bound(data.toString('utf8'), Math.min(c.fileMax, 200000)), encoding: 'utf8', truncated: Buffer.byteLength(data.toString('utf8')) > Math.min(c.fileMax, 200000)
            };
        }
        case 'list_tree': {
            const rows = await page('/projects/:project/repository/tree', { params: { project }, query: {
                    path: string(a, 'path', false) || undefined, ref: string(a, 'ref'), recursive: false
                } });
            return rows;
        }
        default: throw new Error(`Unknown read tool: ${name}`);
    }
    async function page(template: string, opts: RequestOptions) {
        const pageNumber = a.page === undefined ? 1 : integer(a, 'page', 1, 10000);
        const limit = a.limit === undefined ? 20 : integer(a, 'limit', 1, 100);
        const rows = await api.request<unknown[]>('GET', template, { ...opts, query: { ...opts.query, page: pageNumber, per_page: limit } });
        if (!Array.isArray(rows)) throw new Error('Expected list response');
        const output = readOutput(rows.slice(0, limit), a.full === true, a.group === undefined ? 60000 : Math.floor(60000 / c.searchMax));
        return { items: output.data, output_truncated: output.output_truncated || rows.length > limit,
            page: pageNumber, limit, next_page: rows.length >= limit ? pageNumber + 1 : null };
    }
    async function search(project: number) { return page('/projects/:project/search', { params: { project }, query: {
            scope: 'blobs', search: string(a, 'query', true, 1000), ref: string(a, 'ref', false) || undefined
        } }); }
}
