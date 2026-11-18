// Ported sibling's single argument/refusal/bounds seam, with GitLab !/# refs.
import type { GitLabApi, ProjectScope } from './gitlab-adapter.js';
import type { Config } from './config.js';
import type { GitlabState } from './state.js';
import type { Logger, User, ThreadRef, NormalizedEvent } from './types.js';
export interface ToolContext {
    api: GitLabApi;
    scope: ProjectScope;
    config: Config;
    state: GitlabState;
    user: User;
    logger: Logger;
    tokenExpiry?: string | null;
    onEvent?: (e: NormalizedEvent) => Promise<boolean>;
    touch?: (thread: ThreadRef, title?: string) => Promise<void>;
}
export function string(args: Record<string, unknown>, key: string, required = true, max = 200000): string {
    const v = args[key];
    if (v === undefined && !required)
        return '';
    if (typeof v !== 'string' || (required && !v.trim()) || Buffer.byteLength(v) > max)
        throw new Error(`${key}: expected ${required ? 'non-empty ' : ''}string, at most ${max} bytes`);
    return v;
}
export function integer(args: Record<string, unknown>, key: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
    const v = args[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
        throw new Error(`${key}: expected integer ${min}..${max}`);
    return v;
}
export function boolean(args: Record<string, unknown>, key: string): boolean | undefined {
    if (args[key] === undefined)
        return undefined;
    if (typeof args[key] !== 'boolean')
        throw new Error(`${key}: expected boolean`);
    return args[key] as boolean;
}
export function parseThread(value: unknown): ThreadRef {
    if (typeof value !== 'string')
        throw new Error('thread: expected gitlab:group/project!iid or #iid');
    const m = /^(?:gitlab:)?([^\s!#]+)([!#])([1-9]\d*)$/.exec(value);
    if (!m || !Number.isSafeInteger(Number(m[3])))
        throw new Error('thread: expected group/project!iid (MR) or group/project#iid (issue)');
    return {
        project: m[1], number: Number(m[3]), kind: m[2] === '!' ? 'mr' : 'issue'
    };
}
export async function thread(args: Record<string, unknown>, ctx: ToolContext, write = true): Promise<ThreadRef> {
    const t = parseThread(args.thread);
    const p = await (write ? ctx.scope.write(t.project) : ctx.scope.read(t.project));
    return { ...t, project: p.path_with_namespace };
}
export function base(t: ThreadRef): string { return `/projects/:project/${t.kind === 'mr' ? 'merge_requests' : 'issues'}/:iid`; }
export function params(t: ThreadRef): Record<string, string | number> { return { project: t.project, iid: t.number }; }
