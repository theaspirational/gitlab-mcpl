/** Same two-layer fake pattern as github-mcpl: real adapter over fixture API,
 * and real MCPL server over a duplex stream pair. No live GitLab dependency. */
import { answerServerRequest } from '../scripts/live-test-client.js';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McplConnection, type JsonRpcRequest, type FeatureSetsUpdateParams } from '@animalabs/mcpl-core';
import { readConfig, type Config } from '../src/config.js';
import { GitLabAdapter, ProjectScope, type WireResponse } from '../src/gitlab-adapter.js';
import { GitlabState } from '../src/state.js';
import { GitLabMcplServer } from '../src/server.js';
import { silentLogger, type MergeRequest, type Note, type Pipeline, type Job, type Discussion } from '../src/types.js';
import type { ToolContext } from '../src/tool-support.js';
export const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40), PROJECT = 'team/sub/repo', SELF = { id: 7, username: 'example-user' };
export const TIME = '2026-11-16T12:00:00.000Z';
export function config(overrides: Partial<Config> = {}): Config {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-config-'));
    const token = join(dir, 'token');
    writeFileSync(token, 'fixture-token', { mode: 0o600 });
    try {
        return { ...readConfig({
                GITLAB_URL: 'https://gitlab.invalid', GITLAB_TOKEN_FILE: token, GITLAB_PROJECTS: PROJECT
            }), ...overrides };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export function mr(overrides: Partial<MergeRequest> = {}): MergeRequest { return {
    id: 55, iid: 3, project_id: 1, source_project_id: 1, target_project_id: 1, title: 'MR title', description: 'description', state: 'opened', sha: SHA, author: SELF, source_branch: 'example-user/topic', target_branch: 'main', draft: false, merge_when_pipeline_succeeds: false, detailed_merge_status: 'mergeable', head_pipeline: {
        id: 10, sha: SHA, ref: 'example-user/topic', status: 'success'
    }, created_at: TIME, updated_at: TIME, web_url: `https://gitlab.invalid/${PROJECT}/-/merge_requests/3`, ...overrides
}; }
export function note(overrides: Partial<Note> = {}): Note { return {
    id: 101, body: 'Hello', author: { id: 8, username: 'human' }, system: false, created_at: TIME, updated_at: TIME, ...overrides
}; }
export interface Call {
    method: string;
    path: string;
    url: URL;
    body: Record<string, unknown>;
    tailBytes?: number;
}
export class FakeGitLab {
    calls: Call[] = [];
    mrs: MergeRequest[] = [mr()];
    notes: Note[] = [];
    discussions: Discussion[] = [];
    pipelines: Pipeline[] = [];
    jobs: Job[] = [];
    todos: unknown[] = [];
    scopes = ['api'];
    approvers: {
        user: {
            id: number;
            username: string;
        };
    }[] = [];
    head = SHA;
    trace = 'start\nerror here\nend\n';
    /** All-projects fixtures: projects 2 and 3 answer like project 1, MR rows
     * (and pipelines carrying a project_id) are served per project. */
    multi = false;
    override?: (c: Call) => WireResponse | undefined | Promise<WireResponse | undefined>;
    adapter: GitLabAdapter;
    scope: ProjectScope;
    state = GitlabState.empty();
    ctx!: ToolContext;
    constructor(readonly config: Config = configFactory()) {
        this.adapter = new GitLabAdapter(config, async (url, method, body, tailBytes) => {
            const call = {
                method, path: decodeURIComponent(url.pathname.slice('/api/v4'.length)), url, body: JSON.parse(body ?? '{}') as Record<string, unknown>, tailBytes
            };
            this.calls.push(call);
            return await this.override?.(call) ?? this.response(call);
        }, async () => { });
        this.scope = new ProjectScope(this.adapter, config);
    }
    async init() { await this.scope.initialize(); this.ctx = {
        api: this.adapter, scope: this.scope, config: this.config, state: this.state, user: SELF, logger: silentLogger()
    }; return this; }
    response(c: Call): WireResponse {
        const json = (value: unknown, status = 200) => ({
            status, headers: { 'x-next-page': '' }, text: JSON.stringify(value)
        });
        if (c.path === '/user')
            return json(SELF);
        if (c.path === '/personal_access_tokens/self')
            return json({ scopes: this.scopes, expires_at: '2030-01-01' });
        if (c.path === '/version')
            return json({ version: '17.11.7-ee' });
        if (c.path === '/todos')
            return json(this.todos);
        if (c.path === `/projects/${PROJECT}` || c.path === '/projects/1')
            return json({ id: 1, path_with_namespace: PROJECT });
        if (c.path === '/projects/2' || c.path === '/projects/foreign/repo')
            return json({ id: 2, path_with_namespace: 'foreign/repo' });
        if (/^\/groups\/.+\/projects$/.test(c.path))
            return json([{ id: 1, path_with_namespace: PROJECT }, { id: 2, path_with_namespace: 'foreign/repo' }]);
        const state = (m: MergeRequest) => !c.url.searchParams.has('state') || c.url.searchParams.get('state') === 'all' || m.state === c.url.searchParams.get('state');
        if (c.path === '/merge_requests')
            return json(this.mrs.filter(m => state(m) && (c.url.searchParams.get('scope') !== 'created_by_me' || m.author.id === SELF.id)));
        if (this.multi && (c.path === '/projects/3' || c.path === '/projects/secret/vault'))
            return json({ id: 3, path_with_namespace: 'secret/vault' });
        let rest = c.path.replace(/^\/projects\/(?:1|team\/sub\/repo)/, '');
        const other = this.multi ? /^\/projects\/(?:(2|foreign\/repo)|3|secret\/vault)(\/.*)$/.exec(c.path) : null;
        if (other) {
            const pid = other[1] ? 2 : 3;
            rest = other[2];
            const mine = this.mrs.filter(m => m.project_id === pid);
            const im = /^\/merge_requests\/(\d+)$/.exec(rest);
            if (rest === '/merge_requests')
                return json(mine.filter(state));
            if (im)
                return json(mine.find(m => m.iid === Number(im[1])) ?? {}, mine.some(m => m.iid === Number(im[1])) ? 200 : 404);
            if (rest === '/pipelines')
                return json(this.pipelines.filter(p => (p as { project_id?: number }).project_id === pid));
        }
        if (rest === '/merge_requests') {
            if (c.method === 'POST') {
                const created = mr({ iid: 4, ...c.body });
                this.mrs.push(created);
                return json(created);
            }
            return json(this.mrs.filter(m => (!c.url.searchParams.has('state') || c.url.searchParams.get('state') === 'all' || m.state === c.url.searchParams.get('state')) && (!c.url.searchParams.has('author_id') || String(m.author.id) === c.url.searchParams.get('author_id'))));
        }
        const m = /^\/(merge_requests|issues)\/(\d+)(.*)$/.exec(rest);
        if (m) {
            const item = this.mrs.find(x => x.iid === Number(m[2]));
            if (!item)
                return json({}, 404);
            const end = m[3];
            if (!end) {
                if (c.method === 'PUT')
                    Object.assign(item, c.body);
                return json(item);
            }
            if (end === '/diffs')
                return json([{
                        old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new'
                    }]);
            if (end === '/approvals')
                return json({ approved_by: this.approvers });
            if (end === '/discussions')
                return json(this.discussions.length ? this.discussions : [{
                        id: 'd'.repeat(40), individual_note: false, notes: this.notes
                    }]);
            if (end === '/pipelines')
                return json(this.pipelines);
            if (end === '/merge') {
                if (c.body.sha !== item.sha)
                    return json({}, 409);
                item.state = 'merged';
                item.merge_commit_sha = SHA2;
                return json(item);
            }
            if (end === '/rebase')
                return json({}, 202);
            const nm = /^\/notes(?:\/(\d+))?$/.exec(end);
            if (nm || /^\/discussions\/[^/]+\/notes$/.test(end)) {
                const id = nm?.[1] ? Number(nm[1]) : undefined;
                let found = this.notes.find(n => n.id === id);
                if (c.method === 'POST') {
                    found = note({
                        id: 200 + this.notes.length, body: String(c.body.body), author: SELF
                    });
                    this.notes.push(found);
                    return json(found, 201);
                }
                if (id === undefined)
                    return json(this.notes);
                if (!found)
                    return json({}, 404);
                if (c.method === 'PUT') {
                    found.body = String(c.body.body);
                    return json(found);
                }
                if (c.method === 'DELETE') {
                    this.notes = this.notes.filter(n => n.id !== id);
                    return {
                        status: 204, headers: {}, text: ''
                    };
                }
                return json(found);
            }
        }
        if (rest === '/pipelines')
            return json(this.pipelines.filter(p => !this.multi || [undefined, 1].includes((p as { project_id?: number }).project_id)));
        const pi = /^\/pipelines\/(\d+)(\/jobs|\/retry)?$/.exec(rest);
        if (pi) {
            const p = this.pipelines.find(x => x.id === Number(pi[1])) ?? mr().head_pipeline!;
            return json(pi[2] === '/jobs' ? this.jobs : pi[2] === '/retry' ? { ...p, status: 'pending' } : p);
        }
        const job = /^\/jobs\/(\d+)(\/trace|\/retry)?$/.exec(rest);
        if (job) {
            if (job[2] === '/trace')
                return {
                    status: 200, headers: {}, text: this.trace
                };
            return json(this.jobs.find(j => j.id === Number(job[1])) ?? { id: Number(job[1]), ref: 'main' });
        }
        if (rest.startsWith('/repository/branches/'))
            return json({ commit: {
                    id: this.head, author_name: 'Human', committer_name: 'Human'
                } });
        if (rest.startsWith('/repository/files/'))
            return json({
                file_name: 'file.txt', size: 6, encoding: 'base64', content: Buffer.from('hello!').toString('base64')
            });
        if (rest === '/repository/tree')
            return json([{
                    id: SHA, name: 'file.txt', type: 'blob', path: 'file.txt', mode: '100644'
                }]);
        if (rest === '/search')
            return json([{
                    basename: 'file.txt', data: 'found query', path: 'file.txt', filename: 'file.txt', ref: 'main', startline: 1
                }]);
        if (rest === '/issues')
            return json([]);
        return json({ message: '404 Not Found' }, 404);
    }
}
function configFactory() { return config(); }
export async function harness(supplied: FakeGitLab | undefined = undefined, opts: {
    hold?: (r: JsonRpcRequest) => Promise<void> | undefined;
    rejectPush?: boolean;
} = {}) {
    const fake = supplied ?? await new FakeGitLab().init();
    const input = new PassThrough(), output = new PassThrough();
    const conn = McplConnection.fromStreams(input, output), host = McplConnection.fromStreams(output, input);
    const server = new GitLabMcplServer(fake.ctx);
    const saw: JsonRpcRequest[] = [];
    const violations: string[] = [];
    host.on('request', (r: JsonRpcRequest) => {
        saw.push(r);
        const cap = ({
            'channels/register': 'channels.register', 'channels/changed': 'channels.register', 'channels/incoming': 'channels.incoming', 'push/event': 'pushEvents'
        } as Record<string, string>)[r.method];
        if (cap && !server.grant.has(cap)) {
            violations.push(r.method);
            host.sendError(r.id, -32002, 'Not granted');
            return;
        }
        const respond = () => answerServerRequest(host, r, !opts.rejectPush);
        const held = opts.hold?.(r);
        if (held)
            void held.then(respond);
        else
            respond();
    });
    const served = server.serve(conn);
    return {
        server, fake, host, saw, violations, served, async initialize(mcpl = true) { const r = await host.sendRequest('initialize', {
            protocolVersion: '2024-11-05', clientInfo: { name: 'fixture', version: '1' }, capabilities: mcpl ? { experimental: { mcpl: { version: '0.5' } } } : {}
        }); host.sendNotification('notifications/initialized'); return r; }, async grant(capabilities = [
            'tools', 'pushEvents', 'channels.register', 'channels.lifecycle', 'channels.publish', 'channels.incoming', 'channels.typing'
        ], extra: Partial<FeatureSetsUpdateParams> = {}) { return host.sendRequest('featureSets/update', { effectiveCapabilities: capabilities, ...extra }); }, async close() { input.end(); await served; host.close(); }
    };
}
export async function until(test: () => boolean): Promise<void> {
    const end = Date.now() + 2000;
    while (!test()) {
        if (Date.now() > end)
            throw new Error('Timed out');
        await new Promise(r => setTimeout(r, 5));
    }
}
