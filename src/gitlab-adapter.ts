import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { cleanTrace, TraceCleaner } from './trace.js';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { projectMatches, type Config } from './config.js';
import type { Project, User, Logger } from './types.js';
import { bound, rejectMergeKeys, safeText } from './safety.js';
// Static templates, not regexes over arbitrary caller URLs. Parameters are encoded
// as ONE segment. No redirect, URL passthrough, GraphQL or arbitrary-body endpoint.
const reads = [
    '/user', '/personal_access_tokens/self', '/version', '/todos', '/merge_requests', '/projects/:project', '/groups/:group/projects',
    '/projects/:project/merge_requests', '/projects/:project/merge_requests/:iid',
    '/projects/:project/merge_requests/:iid/diffs', '/projects/:project/merge_requests/:iid/approvals',
    '/projects/:project/merge_requests/:iid/pipelines', '/projects/:project/issues', '/projects/:project/issues/:iid',
    '/projects/:project/pipelines', '/projects/:project/pipelines/:pipeline', '/projects/:project/pipelines/:pipeline/jobs',
    '/projects/:project/jobs/:job', '/projects/:project/jobs/:job/trace', '/projects/:project/search',
    '/projects/:project/repository/files/:file', '/projects/:project/repository/tree', '/projects/:project/repository/branches/:branch',
    ...['merge_requests', 'issues'].flatMap(k => [`/projects/:project/${k}/:iid/notes`, `/projects/:project/${k}/:iid/notes/:note`, `/projects/:project/${k}/:iid/discussions`]),
];
const writes: Record<string, {
    set: string;
    fields: string[];
}> = {
    'POST /projects/:project/merge_requests': { set: 'gitlab.mr', fields: [
            'source_branch', 'target_branch', 'title', 'description', 'reviewer_ids', 'labels', 'remove_source_branch'
        ] },
    'PUT /projects/:project/merge_requests/:iid': { set: 'gitlab.mr', fields: [
            'title', 'description', 'target_branch', 'reviewer_ids', 'labels', 'remove_source_branch'
        ] },
    'PUT /projects/:project/merge_requests/:iid/rebase': { set: 'gitlab.rebase', fields: [] },
    'PUT /projects/:project/merge_requests/:iid/merge': { set: 'gitlab.merge', fields: ['sha', 'should_remove_source_branch'] },
};
for (const k of ['merge_requests', 'issues']) {
    writes[`POST /projects/:project/${k}/:iid/notes`] = { set: 'gitlab.comments', fields: ['body'] };
    writes[`PUT /projects/:project/${k}/:iid/notes/:note`] = { set: 'gitlab.comments', fields: ['body'] };
    writes[`DELETE /projects/:project/${k}/:iid/notes/:note`] = { set: 'gitlab.comments', fields: [] };
    writes[`POST /projects/:project/${k}/:iid/discussions/:discussion/notes`] = { set: 'gitlab.comments', fields: ['body'] };
}
export type Params = Record<string, string | number>;
export type Query = Record<string, string | number | boolean | undefined>;
export interface RequestOptions {
    params?: Params;
    query?: Query;
    body?: Record<string, unknown>;
    tailBytes?: number;
    /** Strip runner framing before applying tailBytes (event tails only). */
    cleanTrace?: boolean;
    stopBefore?: {
        field: string;
        value: string;
    };
}
export interface GitLabApi {
    request<T>(method: string, template: string, options?: RequestOptions): Promise<T>;
    list<T>(template: string, options?: RequestOptions): Promise<T[]>;
}
export class GitLabError extends Error {
    constructor(readonly status: number, readonly template: string) { super(`GitLab ${status} on ${template}${status === 403 ? ': insufficient permission or scope' : ''}`); }
}
export interface WireResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    text: string;
}
export type Transport = (url: URL, method: string, body: string | undefined, tailBytes?: number, clean?: boolean) => Promise<WireResponse>;
export class GitLabAdapter implements GitLabApi {
    private transport: Transport;
    constructor(readonly config: Config, transport?: Transport, private sleep = (ms: number) => delay(ms)) {
        this.transport = transport ?? ((url, method, body, tailBytes, clean) => this.send(url, method, body, tailBytes, clean));
    }
    async request<T>(method: string, template: string, opts: RequestOptions = {}): Promise<T> {
        return this.requestWithHeaders<T>(method, template, opts);
    }
    private async requestWithHeaders<T>(method: string, template: string, opts: RequestOptions, headers?: (h: http.IncomingHttpHeaders) => void): Promise<T> {
        const write = writes[`${method} ${template}`];
        if (/merge_ref|cancel_merge_when|auto_merge/.test(template))
            throw new Error('Forbidden endpoint');
        if (method !== 'GET' && (!write || !this.config.featureSets.includes(write.set as never)))
            throw new Error(`Endpoint not allowed: ${method} ${template}`);
        if (method === 'GET' && !reads.includes(template))
            throw new Error(`Endpoint not allowed: GET ${template}`);
        rejectMergeKeys(opts.body);
        rejectMergeKeys(opts.query);
        if (method === 'GET' && opts.body)
            throw new Error('GET body forbidden');
        if (write) {
            if (opts.query && Object.keys(opts.query).length)
                throw new Error('Write query forbidden');
            for (const key of Object.keys(opts.body ?? {}))
                if (!write.fields.includes(key))
                    throw new Error(`Field not allowed: ${key}`);
            if (template.endsWith('/merge') && (!this.config.mergeTargetAllow.length || !/^[a-fA-F0-9]{40}$/.test(String(opts.body?.sha)) || (opts.body?.should_remove_source_branch !== undefined && opts.body.should_remove_source_branch !== this.config.mergeRemoveSource)))
                throw new Error('Invalid exact-SHA merge request');
        }
        let path = template.replace(/:([a-z]+)/g, (_, key: string) => {
            const val = opts.params?.[key];
            if (val === undefined || String(val) === '' || String(val) === '.' || String(val) === '..')
                throw new Error(`Missing or invalid path parameter: ${key}`);
            return encodeURIComponent(String(val));
        });
        const url = new URL(this.config.url + '/api/v4' + path);
        for (const [k, v] of Object.entries(opts.query ?? {}))
            if (v !== undefined)
                url.searchParams.set(k, String(v));
        const body = opts.body ? JSON.stringify(safeText(opts.body)) : undefined;
        for (let attempt = 0;; attempt++) {
            let res: WireResponse;
            try { res = await this.transport(url, method, body, opts.tailBytes, opts.cleanTrace); }
            catch (error) {
                // Only expose a bounded error code, never arbitrary transport messages
                // (which can contain URLs, headers or credentials).
                const code = (error as NodeJS.ErrnoException)?.code;
                const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'TRANSPORT_ERROR';
                const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(safeCode);
                throw new Error(`GitLab ${method} transport failed (${safeCode}) on ${template}.` +
                    (tls ? ' TLS certificate verification failed. Node default trust may not include your internal CA; set GITLAB_CA_FILE to a PEM CA bundle (for example /etc/ssl/certs/ca-certificates.crt on Debian/Ubuntu).' : '') +
                    (method === 'GET' ? ' Read failed.' : ' Write outcome may be unknown. Do not blindly retry.'));
            }
            // Writes (including merge) are NEVER automatically retried: a lost answer
            // is an uncertain outcome, not evidence the side effect did not happen.
            if (method === 'GET' && [429, 502, 503, 504].includes(res.status) && attempt < 2) {
                const header = res.headers['retry-after'];
                const s = Array.isArray(header) ? header[0] : header;
                const resetHeader = res.headers['ratelimit-reset'];
                const reset = Array.isArray(resetHeader) ? resetHeader[0] : resetHeader;
                const wait = s ? (/^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s) - Date.now()) : reset ? Number(reset) * 1000 - Date.now() : 500 * 2 ** attempt;
                if (!Number.isFinite(wait) || wait > 60000)
                    throw new GitLabError(res.status, template);
                await this.sleep(Math.max(0, wait));
                continue;
            }
            if (method !== 'GET' && res.status >= 500)
                throw new Error(`GitLab ${res.status} on ${template}; write outcome may be unknown. Inspect before retrying.`);
            if (res.status < 200 || res.status >= 300)
                throw new GitLabError(res.status, template);
            headers?.(res.headers);
            // Custom/fixture transports may return the full trace. Native HTTP
            // already cleans incrementally before retaining its bounded tail.
            if (template.endsWith('/trace'))
                return (opts.cleanTrace ? bound(cleanTrace(res.text), opts.tailBytes ?? 65536, true) : res.text) as T;
            if (res.status === 204 || !res.text)
                return undefined as T;
            try {
                return JSON.parse(res.text) as T;
            }
            catch {
                throw new Error(`Invalid JSON on ${template}`);
            }
        }
    }
    async list<T>(template: string, opts: RequestOptions = {}): Promise<T[]> {
        // Offset pagination works on 17.11. Never follow Link headers (credential
        // exfiltration). Notes may be filtered AFTER pagination, even to zero rows.
        const result: T[] = [];
        for (let page = 1; page <= 100; page++) {
            let next: string | string[] | undefined;
            const rows = await this.requestWithHeaders<T[]>('GET', template, { ...opts, query: {
                    ...opts.query, per_page: 100, page
                } }, headers => { next = headers['x-next-page']; });
            if (!Array.isArray(rows))
                throw new Error(`Expected list on ${template}`);
            result.push(...rows);
            const last = rows.at(-1) as Record<string, unknown> | undefined;
            const cutoff = opts.stopBefore;
            if (next !== undefined && next !== '' && (typeof next !== 'string' || !/^[1-9]\d*$/.test(next) || Number(next) !== page + 1))
                throw new Error(`Invalid pagination metadata on ${template}`);
            if (next === undefined && template.endsWith('/notes'))
                throw new Error(`Missing notes pagination metadata on ${template}; cursor not advanced`);
            if (next === '' || (next === undefined && rows.length < 100) || (cutoff && typeof last?.[cutoff.field] === 'string' && String(last[cutoff.field]) < cutoff.value))
                return result;
        }
        throw new Error(`Pagination bound reached on ${template}; narrow the query (cursor not advanced)`);
    }
    private send(url: URL, method: string, body: string | undefined, tailBytes?: number, clean = false): Promise<WireResponse> {
        return new Promise((resolve, reject) => {
            const send = url.protocol === 'https:' ? https.request : http.request;
            const req = send(url, {
                method, ca: this.config.ca, headers: {
                    'PRIVATE-TOKEN': this.config.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
                }
            }, res => {
                let data = Buffer.alloc(0), total = 0;
                const cleaner = clean ? new TraceCleaner() : undefined;
                const decoder = new StringDecoder('utf8');
                const retain = (chunk: Buffer) => {
                    data = Buffer.concat([data, chunk]);
                    if (tailBytes !== undefined && data.length > tailBytes)
                        data = data.subarray(data.length - tailBytes);
                };
                res.on('data', (chunk: Buffer) => {
                    total += chunk.length;
                    if (tailBytes !== undefined) {
                        retain(cleaner ? Buffer.from(cleaner.push(decoder.write(chunk))) : chunk);
                    }
                    else if (total > 8000000)
                        req.destroy(new Error('GitLab response exceeds 8 MB transport bound'));
                    else
                        data = Buffer.concat([data, chunk]);
                });
                res.on('end', () => {
                    if (cleaner) retain(Buffer.from(cleaner.push(decoder.end()) + cleaner.end()));
                    clearTimeout(timer); resolve({
                    status: res.statusCode ?? 500, headers: res.headers, text: data.toString('utf8').replace(/^\uFFFD+/, '')
                }); });
                res.on('error', () => req.destroy(new Error('GitLab response interrupted')));
            });
            const timer = setTimeout(() => req.destroy(Object.assign(new Error('GitLab request timed out'), { code: 'ETIMEDOUT' })), this.config.timeout);
            req.on('error', error => { clearTimeout(timer); reject(error); });
            req.end(body);
        });
    }
}
/** Resolve numeric aliases before scope decisions. Never trust a caller's path
 * spelling as proof of membership: server-returned id and canonical path win. */
export class ProjectScope {
    readonly projects = new Map<string, Project>();
    private allowed = new Set<number>();
    constructor(readonly api: GitLabApi, readonly config: Config) { }
    private initialized = false;
    private initializing?: Promise<void>;
    get ready(): boolean { return this.initialized; }
    private requireReady(): void {
        if (!this.ready)
            throw new Error('GitLab project scope not ready; validation pending, retry later');
    }
    /** Single-flight, retryable and atomic: partial startup resolution is never
     * event/write authority. Explicit READ_ALLOW reads remain independent. */
    initialize(): Promise<void> {
        if (this.ready)
            return Promise.resolve();
        if (!this.initializing)
            this.initializing = this.initializeScope().finally(() => { this.initializing = undefined; });
        return this.initializing;
    }
    private async initializeScope(): Promise<void> {
        const allowed = new Set<number>();
        for (const entry of this.config.projects)
            allowed.add((await this.resolve(entry)).id);
        const watch = async (entry: string) => {
            const p = await this.resolve(entry);
            if (!(this.config.allProjects ? !projectMatches(p, this.config.projectsExclude) : allowed.has(p.id)))
                throw new Error(this.config.allProjects ? `Project ${p.path_with_namespace} is excluded by GITLAB_PROJECTS_EXCLUDE` : `Project ${p.path_with_namespace} is not in GITLAB_PROJECTS`);
        };
        for (const entry of this.config.pipelineProjects)
            await watch(entry);
        for (const entry of this.config.branchWatch) {
            const at = entry.lastIndexOf(':');
            if (at < 1 || !entry.slice(at + 1))
                throw new Error('GITLAB_BRANCH_WATCH: expected project:branch');
            await watch(entry.slice(0, at));
        }
        this.allowed = allowed;
        this.initialized = true;
    }
    async resolve(entry: string | number): Promise<Project> {
        const key = String(entry);
        const cached = this.projects.get(key);
        if (cached)
            return cached;
        const p = await this.api.request<Project>('GET', '/projects/:project', { params: { project: key } });
        if (!Number.isSafeInteger(p.id) || p.id <= 0 || !p.path_with_namespace)
            throw new Error('Invalid project response');
        this.projects.set(key, p);
        this.projects.set(String(p.id), p);
        this.projects.set(p.path_with_namespace, p);
        return p;
    }
    /** Event eligibility: polling sources, event delivery and channel lifecycle.
     * Never a write authorization; see `write`. */
    async watch(entry: string | number): Promise<Project> {
        this.requireReady();
        const p = await this.resolve(entry);
        if (!this.allows(p))
            throw new Error(this.config.allProjects ? `Project ${p.path_with_namespace} is excluded by GITLAB_PROJECTS_EXCLUDE` : `Project ${p.path_with_namespace} is not in GITLAB_PROJECTS`);
        return p;
    }
    /** Write authorization for every tool, channel publication and rollback.
     * List mode: GITLAB_PROJECTS, as always. All-projects mode: `*` implies
     * nothing; the project must match GITLAB_WRITE_ALLOW and not be excluded. */
    async write(entry: string | number): Promise<Project> {
        const p = await this.watch(entry);
        if (this.config.allProjects && !projectMatches(p, this.config.writeAllow.filter(rule => rule !== '*')))
            throw new Error(`Project ${p.path_with_namespace} is not in GITLAB_WRITE_ALLOW`);
        return p;
    }
    async read(entry: string | number): Promise<Project> {
        const p = await this.resolve(entry);
        if (!projectMatches(p, this.config.readAllow))
            throw new Error(`Project ${p.path_with_namespace} is not in GITLAB_READ_ALLOW`);
        return p;
    }
    // Event scope (and, in list mode only, write scope). All-projects mode has
    // no list: every project the token resolves is in event scope unless an
    // exclude rule matches its canonical id/path.
    private allows(p: Project): boolean { return this.config.allProjects ? !projectMatches(p, this.config.projectsExclude) : this.allowed.has(p.id); }
    /** Synchronous: only projects already resolved, and only when in event scope. */
    event(id: number): Project | undefined {
        const p = this.projects.get(String(id));
        return this.ready && p && this.allows(p) ? p : undefined;
    }
    /** Persisted poll state names projects by the canonical path an EARLIER
     * configuration stored. Decide whether that path is in the CURRENT event
     * scope. List mode never reads GitLab for this: every listed project was
     * resolved at startup, so an unknown path is out of scope. All-projects
     * mode refuses a path rule without I/O and otherwise resolves the project
     * once, so id rules and renames are honoured; a project the token can no
     * longer see is out of scope, any other failure is thrown (undecided). */
    async persisted(path: unknown): Promise<boolean> {
        this.requireReady();
        if (typeof path !== 'string' || !path)
            return false;
        if (!this.config.allProjects) {
            const p = this.projects.get(path);
            return !!p && p.path_with_namespace === path && this.allows(p);
        }
        if (projectMatches({ id: 0, path_with_namespace: path }, this.config.projectsExclude))
            return false;
        try {
            const p = await this.resolve(path);
            return p.path_with_namespace === path && this.allows(p);
        }
        catch (error) {
            if (error instanceof GitLabError && (error.status === 403 || error.status === 404))
                return false;
            throw error;
        }
    }
    /** Event rows may reveal nothing but a numeric project id. In all-projects
     * mode it is resolved to the canonical path BEFORE the exclude decision, so
     * a path or prefix exclude also holds for id-only rows. A project the token
     * can no longer see is no event; any other failure fails the source. */
    async discover(id: number): Promise<Project | undefined> {
        this.requireReady();
        if (!this.config.allProjects)
            return this.event(id);
        if (!Number.isSafeInteger(id) || id <= 0)
            return undefined;
        try {
            const p = await this.resolve(id);
            return this.allows(p) ? p : undefined;
        }
        catch (error) {
            if (error instanceof GitLabError && (error.status === 403 || error.status === 404))
                return undefined;
            throw error;
        }
    }
}
export async function startup(api: GitLabApi, config: Config, logger: Logger): Promise<{
    user: User;
    expiresSoon: boolean;
    expiresAt: string | null;
}> {
    const user = await api.request<User>('GET', '/user');
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.username)
        throw new Error('Invalid GitLab identity');
    if (config.expectUsername && user.username !== config.expectUsername)
        throw new Error('GITLAB_EXPECT_USERNAME: account mismatch');
    const token = await api.request<{
        scopes: string[];
        expires_at: string | null;
    }>('GET', '/personal_access_tokens/self');
    for (const set of config.featureSets) {
        const scope = ['gitlab.read', 'gitlab.events'].includes(set) ? 'read_api' : 'api';
        if (!token.scopes.includes('api') && !token.scopes.includes(scope))
            throw new Error(`${set} requires token scope ${scope}`);
    }
    const expiresSoon = !!token.expires_at && Date.parse(token.expires_at) - Date.now() < 14 * 86400000;
    if (expiresSoon)
        logger.warn('GitLab token expires in fewer than 14 days');
    logger.info('GitLab authenticated', {
        username: user.username, id: user.id
    });
    return {
        user, expiresSoon, expiresAt: token.expires_at
    };
}
