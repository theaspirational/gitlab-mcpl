import { bound } from './safety.js';
import { featureSetForTool, type ToolResult } from './types.js';
import { readTool } from './tools-read.js';
import { commentsTool } from './tools-comments.js';
import { writeTool } from './tools-write.js';
import type { ToolContext } from './tool-support.js';
import { renderData } from './content.js';
type Property = {
    type: 'string' | 'integer' | 'boolean';
    description?: string;
    minimum?: number;
    maximum?: number;
};
const s: Property = { type: 'string' }, n: Property = { type: 'integer', minimum: 1 }, b: Property = { type: 'boolean' };
const project: Property = { type: 'string', description: 'Canonical project path or numeric id; fenced by configured read/write scope.' };
const thread: Property = { type: 'string', description: 'gitlab:group/subgroup/project!iid for MR; #iid for issue.' };
const specs: Record<string, {
    desc: string;
    props: Record<string, Property>;
    required: string[];
}> = {
    get_merge_request: {
        desc: 'Read compact MR metadata; optionally include paged diffs, discussions and Free approvals.', props: {
            project, iid: n, include: { ...s, description: 'Comma-separated diff,discussions,approvals; defaults to metadata only. Lists use page/limit.' }
        }, required: ['project', 'iid']
    },
    list_merge_requests: {
        desc: 'List MRs (17.11 wip filter).', props: {
            project, state: s, author_id: n, reviewer: s, draft: b
        }, required: ['project']
    },
    list_discussions: {
        desc: 'Read discussions with d:<id> thread ids.', props: { thread }, required: ['thread']
    },
    list_pipelines: {
        desc: 'List project or MR pipelines, optionally by SHA/ref.', props: {
            project, iid: n, sha: s, ref: s
        }, required: ['project']
    },
    get_pipeline: {
        desc: 'Read pipeline and jobs including failure reasons.', props: { project, pipeline_id: n }, required: ['project', 'pipeline_id']
    },
    get_job_log: {
        desc: 'Bounded tail, optionally literal grep with context. No regular expressions.', props: {
            project, job_id: n, max_bytes: n, grep: s, context: {
                type: 'integer', minimum: 0, maximum: 20
            }
        }, required: ['project', 'job_id']
    },
    search_code: {
        desc: 'Project basic blob search, or capped group fan-out on Free; choose project or group.', props: {
            project, group: s, query: s, ref: s
        }, required: ['query']
    },
    get_file: {
        desc: 'Read bounded UTF-8 file content at a ref.', props: {
            project, path: s, ref: s
        }, required: ['project', 'path', 'ref']
    },
    list_tree: {
        desc: 'List bounded repository tree at a ref.', props: {
            project, path: s, ref: s
        }, required: ['project', 'ref']
    },
    get_issue: {
        desc: 'Read issue metadata.', props: { project, iid: n }, required: ['project', 'iid']
    },
    comment: {
        desc: 'Post a neutralised comment; rollback can delete it.', props: { thread, body: s }, required: ['thread', 'body']
    },
    reply_in_thread: {
        desc: 'Reply to a GitLab discussion.', props: {
            thread, thread_id: s, body: s
        }, required: ['thread', 'thread_id', 'body']
    },
    edit_own_comment: {
        desc: 'Edit note owned by the numeric authenticated user; rollback restores text.', props: {
            thread, note_id: n, body: s
        }, required: ['thread', 'note_id', 'body']
    },
    delete_own_comment: {
        desc: 'Delete own note. GitLab has no undelete; rollback reports the loss.', props: { thread, note_id: n }, required: ['thread', 'note_id']
    },
    upsert_sticky_comment: {
        desc: 'Upsert own note by safe marker key.', props: {
            thread, marker: s, body: s
        }, required: ['thread', 'marker', 'body']
    },
    create_merge_request: {
        desc: 'Create MR with source/target guards; never enable auto-merge.', props: {
            project, source_branch: s, target_branch: s, title: s, description: s, draft: b, labels: s, remove_source_branch: b
        }, required: ['project', 'source_branch', 'target_branch', 'title']
    },
    edit_merge_request: {
        desc: 'Edit only allowed MR fields; draft=false removes Draft prefix on 17.11.', props: {
            project, iid: n, title: s, description: s, draft: b, target_branch: s, labels: s, remove_source_branch: b
        }, required: ['project', 'iid']
    },
    request_review: {
        desc: 'Set exactly one reviewer (Free tier).', props: {
            project, iid: n, reviewer_id: n
        }, required: ['project', 'iid', 'reviewer_id']
    },
    retry_pipeline: {
        desc: 'Unavailable: fails closed because GitLab 17.11 CI retries can trigger associated auto-merge.', props: { project, pipeline_id: n }, required: ['project', 'pipeline_id']
    },
    retry_job: {
        desc: 'Unavailable: fails closed because GitLab 17.11 CI retries can trigger associated auto-merge.', props: { project, job_id: n }, required: ['project', 'job_id']
    },
    rebase_merge_request: {
        desc: 'Opt-in source-branch rebase. Refuses auto-merge and disallowed source projects/branches; never skip_ci.', props: { project, iid: n }, required: ['project', 'iid']
    },
    merge_at_sha: {
        desc: 'Opt-in, MCPL-granted exact-head merge with explained refusals; no auto-merge or retries.', props: {
            project, iid: n, sha: { ...s, description: 'Required full 40-hex commit SHA.' }
        }, required: ['project', 'iid', 'sha']
    },
};
for (const [name, spec] of Object.entries(specs)) {
    if (featureSetForTool(name) !== 'gitlab.read' || ['get_file', 'get_job_log'].includes(name)) continue;
    spec.props.full = { ...b, description: 'Include additional API fields; text and total output budgets still apply.' };
    if (name !== 'get_issue') {
        spec.props.page = { ...n, maximum: 10000, description: '1-based page (default 1); applies to each nested list.' };
        spec.props.limit = { ...n, maximum: 100, description: 'Rows per page (default 20, max 100). next_page is conservative; final page may be empty.' };
    }
}
export const TOOL_DEFINITIONS = Object.entries(specs).map(([name, d]) => ({
    name, description: d.desc, inputSchema: {
        type: 'object', properties: d.props, required: d.required, additionalProperties: false
    }
}));
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const auditBefore = ctx.state.snapshot().audit.at(-1)?.id;
    const spec = specs[name];
    if (!spec)
        throw new Error(`Unknown tool: ${name}`);
    try {
        if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('Arguments must be an object');
        const a = args as Record<string, unknown>;
        for (const k of spec.required)
            if (a[k] === undefined)
                throw new Error(`${k}: required`);
        for (const [k, v] of Object.entries(a)) {
            const p = spec.props[k];
            if (!p)
                throw new Error(`Unknown argument: ${k}`);
            if (p.type === 'integer' ? typeof v !== 'number' || !Number.isSafeInteger(v) || v < (p.minimum ?? 1) || v > (p.maximum ?? Number.MAX_SAFE_INTEGER) : typeof v !== p.type)
                throw new Error(`${k}: expected ${p.type}`);
            if (typeof v === 'string' && Buffer.byteLength(v) > 200000)
                throw new Error(`${k}: exceeds input bound`);
        }
        const set = featureSetForTool(name)!;
        if (!ctx.config.featureSets.includes(set) || ctx.config.toolsDeny.includes(name))
            throw new Error(`Tool disabled: ${name}`);
        const data = await (set === 'gitlab.read' ? readTool(name, a, ctx) : set === 'gitlab.comments' ? commentsTool(name, a, ctx) : writeTool(name, a, ctx));
        return { content: renderData(data) };
    }
    catch (e) {
        return { isError: true, content: [{ type: 'text', text: bound(e instanceof Error ? e.message : 'Tool failed',8000) }] };
    }
    finally {
        if (name === 'merge_at_sha' && ctx.state.snapshot().audit.at(-1)?.id === auditBefore) {
            const raw = args && typeof args === 'object' ? args as Record<string, unknown> : {};
            const entry = {
                tool: name, sha: typeof raw.sha === 'string' && /^[a-f0-9]{40}$/i.test(raw.sha) ? raw.sha : 'invalid', outcome: 'refused-before-preflight'
            };
            ctx.logger.info('merge audit', entry);
            ctx.state.audit(entry);
            try {
                await ctx.state.flush();
            }
            catch {
                ctx.logger.error('Merge refusal audit persistence failed');
            }
        }
    }
}
