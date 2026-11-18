import { mentionsUser } from './normalize.js';
import type { ToolContext } from './tool-support.js';
import type { MergeRequest, Pipeline, Job, Note, Discussion, NormalizedEvent, Todo, User } from './types.js';
import { glob } from './config.js';
import { bound } from './safety.js';
const MR = '/projects/:project/merge_requests';
const terminal = new Set(['success', 'failed', 'canceled', 'skipped']);
const inflight = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running']);
interface Watch {
    project: string;
    pipeline: number;
    iid: number;
    own: boolean;
    sha: string;
}
interface Merged {
    project: string;
    iid: number;
    sha: string;
    expires: number;
}
type Own = Pick<MergeRequest, 'iid' | 'project_id' | 'sha'>;
interface Marker {
    revision?: number;
    sha: string;
    state: string;
    updated: string;
}
export class Poller {
    private timer?: ReturnType<typeof setTimeout>;
    private hotTimer?: ReturnType<typeof setTimeout>;
    private stopped = true;
    private queue: Promise<void> = Promise.resolve();
    private pass = 0;
    private validated = false;
    constructor(readonly ctx: ToolContext, readonly onEvent: (e: NormalizedEvent) => Promise<boolean>, readonly now = () => Date.now(), readonly enabled = () => true) { }
    private enqueue(work: () => Promise<void>): Promise<void> { const run = this.queue.then(work, work); this.queue = run.catch(() => { }); return run; }
    start(): void {
        if (!this.stopped)
            return;
        this.stopped = false;
        const loop = async () => {
            try {
                await this.poll();
            }
            catch {
                this.ctx.logger.warn('Poll pass incomplete; cursors retained');
            }
            if (!this.stopped)
                this.timer = setTimeout(loop, this.ctx.config.pollInterval);
        };
        const hot = async () => {
            try {
                await this.hotPoll();
            }
            catch {
                this.ctx.logger.warn('Hot poll incomplete; watches retained');
            }
            if (!this.stopped)
                this.hotTimer = setTimeout(hot, this.ctx.config.hotInterval);
        };
        void loop();
        if (this.ctx.config.hotInterval)
            this.hotTimer = setTimeout(hot, this.ctx.config.hotInterval);
    }
    stop(): void { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.hotTimer); }
    whenIdle(): Promise<void> { return this.queue; }
    poll(): Promise<void> { return this.enqueue(() => this.run()); }
    hotPoll(): Promise<void> {
        return this.enqueue(async () => {
            if (!this.enabled())
                return;
            // Never read a pipeline for a watch the current configuration would
            // not have created. An undecidable scope check throws: no hot I/O.
            await this.prune();
            const watches = this.ctx.state.memory<Record<string, Watch>>('hot', {});
            for (const [key, w] of Object.entries(watches)) {
                const p = await this.ctx.api.request<Pipeline>('GET', '/projects/:project/pipelines/:pipeline', { params: { project: w.project, pipeline: w.pipeline } });
                // Stale watches from an old head cannot claim the replacement head.
                if (p.sha !== w.sha) {
                    delete watches[key];
                    continue;
                }
                await this.pipeline(w.project, p, w.own ? 'own-mr' : 'reviewing', w.iid, w.own);
                if (!inflight.has(p.status))
                    delete watches[key];
            }
            this.ctx.state.remember('hot', watches);
            await this.ctx.state.flush();
        });
    }
    private get wantOwn(): boolean { const c = this.ctx.config; return c.sources.includes('own-mrs') || (c.sources.includes('pipelines') && c.pipelineScope.includes('own-mrs')); }
    private get wantMerges(): boolean { const c = this.ctx.config; return c.sources.includes('pipelines') && c.pipelineScope.includes('own-merges'); }
    /** Revalidate persisted poll state against the current configuration.
     * `index.ts` starts it after transport setup; every poll pass and every hot poll run
     * it again before their first GitLab read. */
    revalidate(): Promise<void> { return this.enqueue(() => this.prune()); }
    /** The state file outlives the configuration that wrote it (same instance
     * and user, different GITLAB_PROJECTS / EVENT_SOURCES / excludes). Nothing
     * persisted may drive a read or an event the current configuration would
     * not start itself:
     *   - hot watches (every call): a reviewer watch needs the `reviewing`
     *     source, an own watch needs own-MR interest, and both need their
     *     project in the current event scope;
     *   - own-MR and own-merge interest sets, and poll cursors (once per
     *     process, the configuration being immutable): entries of a disabled
     *     source or an out-of-scope project are dropped, so a source enabled
     *     again later starts from a fresh window, not from an old cursor.
     * Markers (review/thread/approval/branch), todo-seen and the dedup ring
     * are only ever consulted for a row the current configuration fetched. */
    private async prune(): Promise<void> {
        const { state, scope, config: c } = this.ctx;
        await scope.initialize();
        const decided = new Map<unknown, boolean>();
        const inScope = async (project: unknown): Promise<boolean> => {
            if (!decided.has(project))
                decided.set(project, await scope.persisted(project));
            return decided.get(project)!;
        };
        const record = <T>(key: string): Record<string, T> => {
            const value = state.memory<unknown>(key, {});
            return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {};
        };
        let dropped = 0;
        const hot = record<Watch>('hot');
        for (const [key, w] of Object.entries(hot)) {
            const shaped = !!w && typeof w === 'object' && typeof w.own === 'boolean' && typeof w.sha === 'string' && Number.isSafeInteger(w.pipeline) && Number.isSafeInteger(w.iid);
            const wanted = shaped && (w.own ? this.wantOwn : c.sources.includes('reviewing') && !c.allProjects);
            if (!wanted || !await inScope(w.project)) {
                delete hot[key];
                dropped++;
            }
        }
        const work: (() => void)[] = [() => state.remember('hot', hot)];
        if (!this.validated) {
            const own = record<Own>('own');
            for (const key of Object.keys(own))
                if (!this.wantOwn || !await inScope(key.slice(0, Math.max(0, key.lastIndexOf('!'))))) {
                    delete own[key];
                    dropped++;
                }
            const stored = state.memory<unknown>('merged', []);
            const merged: Merged[] = [];
            for (const m of Array.isArray(stored) ? stored as Merged[] : [])
                if (this.wantMerges && m && typeof m === 'object' && await inScope(m.project))
                    merged.push(m);
                else
                    dropped++;
            const expected = new Set<string>(['token-expiry']);
            if (c.sources.includes('todos'))
                expected.add('todos');
            if (c.allProjects && this.wantOwn)
                expected.add('*:own');
            if (c.allProjects && this.wantMerges)
                expected.add('*:merges');
            for (const entry of c.projects) {
                const project = (await scope.watch(entry)).path_with_namespace;
                if (this.wantOwn)
                    expected.add(`${project}:own`);
                if (this.wantMerges)
                    expected.add(`${project}:merges`);
                if (c.sources.includes('reviewing'))
                    expected.add(`${project}:reviewing`);
                if (c.sources.includes('threads'))
                    expected.add(`${project}:merge_requests`).add(`${project}:issues`);
            }
            if (c.sources.includes('branches'))
                for (const entry of c.branchWatch)
                    expected.add(`branch:${entry}`);
            if (c.sources.includes('pipelines'))
                for (const entry of c.pipelineProjects)
                    expected.add(`${(await scope.watch(entry)).path_with_namespace}:pipelines`);
            const cursors = { ...state.pollCursors() };
            for (const key of Object.keys(cursors)) {
                // All-projects mode discovers pipeline projects at run time: keep an
                // in-scope cursor here, the pass itself drops it once inactive.
                const discovered = c.allProjects && c.sources.includes('pipelines') && key.endsWith(':pipelines') && await inScope(key.slice(0, -10));
                if (!expected.has(key) && !discovered) {
                    delete cursors[key];
                    dropped++;
                }
            }
            work.push(() => { state.remember('own', own); state.remember('merged', merged); state.setPollCursors(cursors); });
        }
        // Nothing is applied until every decision was made: an undecidable
        // project throws above, leaves the state as it was and blocks the I/O.
        if (dropped || !this.validated) {
            for (const apply of work)
                apply();
            this.validated = true;
            if (dropped) {
                this.ctx.logger.info('Dropped persisted poll state outside the current event sources/scope', { entries: dropped });
                await state.flush();
            }
        }
    }
    private async emit(e: NormalizedEvent): Promise<void> {
        const state = this.ctx.state;
        if (state.snapshot().pollKeys.includes(e.id))
            return;
        if (!await this.onEvent(e))
            throw new Error('Event not accepted; retry later');
        state.seenPollKey(e.id);
        await state.flush();
    }
    private async source(key: string, work: (since: string) => Promise<void>): Promise<void> {
        const state = this.ctx.state;
        const start = this.now();
        const cursor = state.pollCursors()[key]?.since ?? new Date(start - this.ctx.config.pollInterval).toISOString();
        if (!state.pollCursors()[key]) {
            state.setPollCursors({ ...state.pollCursors(), [key]: { since: cursor } });
        }
        // Persist the first lower bound before any I/O or delivery. Retain it in
        // memory even if persistence fails, so a subsequent attempt cannot age out.
        await state.flush();
        await work(new Date(Date.parse(cursor) - this.ctx.config.overlap).toISOString());
        state.setPollCursors({ ...state.pollCursors(), [key]: { since: new Date(start).toISOString() } });
        try { await state.flush(); }
        catch (error) {
            state.setPollCursors({ ...state.pollCursors(), [key]: { since: cursor } });
            throw error;
        }
    }
    private async run(): Promise<void> {
        if (!this.enabled())
            return;
        const { ctx } = this;
        const c = ctx.config;
        await this.prune();
        this.pass++;
        // No external ingress in plain MCP or before a host grant. onEvent refuses
        // delivery and the failed source does not advance. Other sources still run.
        const failures: string[] = [];
        const attempt = async (key: string, f: (since: string) => Promise<void>) => {
            try {
                await this.source(key, f);
            }
            catch {
                failures.push(key);
            }
        };
        if (ctx.tokenExpiry && Date.parse(ctx.tokenExpiry) - this.now() < 14 * 86400000) {
            await attempt('token-expiry', async () => {
                if (ctx.state.memory<string | null>('expiry-notice', null) === ctx.tokenExpiry)
                    return;
                // All-projects mode has no first project to anchor on: the notice
                // goes to the connector-level `gitlab:*@pipelines` channel instead.
                const project = c.allProjects ? '*' : (await ctx.scope.watch(c.projects[0])).path_with_namespace;
                await this.emit({
                    id: `token.expiring:${ctx.tokenExpiry}`, kind: 'token.expiring', project, receivedAt: new Date(this.now()).toISOString(), body: `GitLab PAT expires on ${ctx.tokenExpiry}; rotate it out of band and restart.`
                });
                ctx.state.remember('expiry-notice', ctx.tokenExpiry);
            });
        }
        if (c.sources.includes('todos'))
            await attempt('todos', since => this.todos(since));
        const { wantOwn, wantMerges } = this;
        // All-projects mode: one instance-level query each, no per-project loop
        // (c.projects is empty). Excludes are applied per row inside.
        if (c.allProjects && wantOwn)
            await attempt('*:own', since => this.own(null, since));
        if (c.allProjects && wantMerges)
            await attempt('*:merges', () => this.merges(null));
        for (const entry of c.projects) {
            const p = await ctx.scope.watch(entry);
            const project = p.path_with_namespace;
            if (wantOwn)
                await attempt(`${project}:own`, since => this.own(project, since));
            if (wantMerges)
                await attempt(`${project}:merges`, () => this.merges(project));
            if (c.sources.includes('reviewing'))
                await attempt(`${project}:reviewing`, since => this.reviewing(project, since));
            if (c.sources.includes('threads'))
                for (const kind of ['merge_requests', 'issues'])
                    await attempt(`${project}:${kind}`, since => this.threads(project, kind, since));
        }
        if (c.sources.includes('branches'))
            for (const entry of c.branchWatch)
                await attempt(`branch:${entry}`, () => this.branch(entry));
        if (c.sources.includes('pipelines'))
            for (const entry of c.pipelineProjects) {
                const p = await ctx.scope.watch(entry);
                if (failures.some(key => key === `${p.path_with_namespace}:own` || key === `${p.path_with_namespace}:merges` || key === '*:own' || key === '*:merges'))
                    continue;
                await attempt(`${p.path_with_namespace}:pipelines`, since => this.pipelines(p.path_with_namespace, since));
            }
        if (c.allProjects && c.sources.includes('pipelines') && !failures.some(key => key === '*:own' || key === '*:merges')) {
            // GitLab has no instance-level pipeline list. The per-project list is
            // read only where this pass found an open or recently merged own MR,
            // and there only own-MR/own-merge interest counts (users/refs need
            // an explicit GITLAB_PIPELINE_PROJECTS entry, handled above).
            const explicit = new Set<string>();
            for (const entry of c.pipelineProjects)
                explicit.add((await ctx.scope.watch(entry)).path_with_namespace);
            const active = new Set<string>();
            if (c.pipelineScope.includes('own-mrs'))
                for (const key of Object.keys(ctx.state.memory<Record<string, Own>>('own', {})))
                    active.add(key.slice(0, key.lastIndexOf('!')));
            if (c.pipelineScope.includes('own-merges'))
                for (const m of ctx.state.memory<Merged[]>('merged', []))
                    if (m.expires > this.now())
                        active.add(m.project);
            for (const project of active)
                if (!explicit.has(project))
                    await attempt(`${project}:pipelines`, since => this.pipelines(project, since, true));
            // A project that left the active set must not resume later from a
            // stale cursor: drop it, so it restarts from a fresh window.
            const cursors = { ...ctx.state.pollCursors() };
            for (const key of Object.keys(cursors))
                if (key.endsWith(':pipelines') && !explicit.has(key.slice(0, -10)) && !active.has(key.slice(0, -10)))
                    delete cursors[key];
            ctx.state.setPollCursors(cursors);
        }
        if (failures.length)
            throw new Error(`Incomplete sources: ${failures.join(', ')}`);
    }
    private async todos(since: string): Promise<void> {
        const seen = this.ctx.state.memory<Record<string, string>>('todo-seen', {});
        const pending = new Set<string>();
        for (const state of ['pending', 'done']) {
            const rows = await this.ctx.api.list<Todo>('/todos', { query: { state, sort: 'desc' }, ...(state === 'done' ? { stopBefore: { field: 'created_at', value: since } } : {}) });
            for (const t of rows) {
                if (!['MergeRequest', 'Issue'].includes(t.target_type) || !t.project || !t.target || !Number.isSafeInteger(t.target.iid))
                    continue;
                const p = await this.ctx.scope.discover(t.project.id);
                if (!p)
                    continue;
                // Pending can be old but still addressed; done rows are a bounded time
                // window logically, paged physically so the auto-done race is not capped at 20.
                if (state === 'done' && t.created_at < since)
                    continue;
                const id = `todo:${t.id}`;
                if (state === 'pending') pending.add(id);
                if (seen[id]) continue;
                const project = p.path_with_namespace;
                await this.emit({
                    id: `todo:${t.id}`, kind: 'todo', project, thread: {
                        project, number: t.target.iid, kind: t.target_type === 'MergeRequest' ? 'mr' : 'issue'
                    }, actor: t.author, receivedAt: t.created_at, body: t.body, url: t.target_url, todoAction: t.action_name, mention: ['mentioned', 'directly_addressed'].includes(t.action_name), own: t.target.author?.id === this.ctx.user.id, data: { todo_id: t.id, action: t.action_name }
                });
                seen[id] = t.created_at;
                this.ctx.state.remember('todo-seen', seen);
                await this.ctx.state.flush();
            }
        }
        // Only prune after BOTH complete reads. Keep every still-pending identity
        // and completed identities still inside the overlap window, not a ring.
        for (const [id, created] of Object.entries(seen))
            if (!pending.has(id) && created < since) delete seen[id];
        this.ctx.state.remember('todo-seen', seen);
    }
    /** `only` null is all-projects mode: one instance-level list (GitLab 17.11
     * Free: GET /merge_requests?scope=created_by_me), each row's project id
     * resolved and exclude-checked before any per-MR read. */
    private async own(only: string | null, since: string): Promise<void> {
        const rows = only === null
            ? await this.ctx.api.list<MergeRequest>('/merge_requests', { query: { scope: 'created_by_me', state: 'opened' } })
            : await this.ctx.api.list<MergeRequest>(MR, { params: { project: only }, query: { author_id: this.ctx.user.id, state: 'opened' } });
        const own: Record<string, Own> = this.ctx.state.memory('own', {});
        for (const key of Object.keys(own))
            if (only === null || key.startsWith(only + '!'))
                delete own[key];
        for (let mr of rows) {
            if (mr.author.id !== this.ctx.user.id)
                continue;
            const project = only ?? (await this.ctx.scope.discover(mr.project_id))?.path_with_namespace;
            if (!project)
                continue;
            mr = await this.ctx.api.request<MergeRequest>('GET', MR + '/:iid', { params: { project, iid: mr.iid } });
            own[`${project}!${mr.iid}`] = {
                iid: mr.iid, project_id: mr.project_id, sha: mr.sha
            };
            if (this.ctx.config.sources.includes('own-mrs')) {
                if (mr.updated_at >= since)
                    await this.notes(project, mr, 'mr', since, true);
                await this.approvals(project, mr);
            }
            this.watch(project, mr, true);
        }
        this.ctx.state.remember('own', own);
        // Remove hot watches for closed or superseded own heads.
        const hot = this.ctx.state.memory<Record<string, Watch>>('hot', {});
        for (const [key, w] of Object.entries(hot))
            if ((only === null || w.project === only) && w.own && own[`${w.project}!${w.iid}`]?.sha !== w.sha)
                delete hot[key];
        this.ctx.state.remember('hot', hot);
    }
    private watch(project: string, mr: Pick<MergeRequest, 'iid' | 'sha' | 'head_pipeline'>, own: boolean): void {
        if (!mr.head_pipeline || !inflight.has(mr.head_pipeline.status) || mr.head_pipeline.sha !== mr.sha)
            return;
        const hot = this.ctx.state.memory<Record<string, Watch>>('hot', {});
        hot[`${project}:${mr.head_pipeline.id}`] = {
            project, pipeline: mr.head_pipeline.id, iid: mr.iid, own, sha: mr.sha
        };
        this.ctx.state.remember('hot', hot);
    }
    private async approvals(project: string, mr: MergeRequest): Promise<void> {
        const data = await this.ctx.api.request<{
            approved_by: {
                user: User;
            }[];
        }>('GET', MR + '/:iid/approvals', { params: { project, iid: mr.iid } });
        const users = data.approved_by.map(x => x.user).sort((a, b) => a.id - b.id);
        const marker = JSON.stringify(users.map(u => u.id));
        const key = `approval:${project}!${mr.iid}`;
        const before = this.ctx.state.memory<{
            users: number[];
            revision: number;
        } | null>(key, null);
        const revision = (before?.revision ?? 0) + (before && JSON.stringify(before.users) !== marker ? 1 : 0);
        if (before && JSON.stringify(before.users) !== marker)
            await this.emit({
                id: `approval:${project}:${mr.iid}:${revision}:${marker}`, kind: 'mr.approval_changed', project, thread: {
                    project, number: mr.iid, kind: 'mr'
                }, receivedAt: new Date(this.now()).toISOString(), own: true, data: { approved_by: users, previous_approver_ids: before.users }
            });
        this.ctx.state.remember(key, { users: users.map(u => u.id), revision });
    }
    private async notes(project: string, item: MergeRequest, kind: 'mr' | 'issue', since: string, own: boolean): Promise<void> {
        const path = `/projects/:project/${kind === 'mr' ? 'merge_requests' : 'issues'}/:iid`;
        const notes = await this.ctx.api.list<Note>(path + '/notes', {
            params: { project, iid: item.iid }, query: { order_by: 'updated_at', sort: 'desc' }, stopBefore: { field: 'updated_at', value: since }
        });
        const changed = notes.filter(n => n.updated_at >= since && (!n.system || this.ctx.config.systemNotes === 'keep'));
        if (!changed.length)
            return;
        const discussions = await this.ctx.api.list<Discussion>(path + '/discussions', { params: { project, iid: item.iid } });
        for (const n of changed) {
            const d = discussions.find(d => d.notes.some(x => x.id === n.id));
            if (!d)
                throw new Error('Note discussion not visible yet; retain cursor for retry');
            if (n.updated_at < since || (n.system && this.ctx.config.systemNotes === 'drop'))
                continue;
            const earlier = d.notes.some(other => other.id < n.id && other.author.id === this.ctx.user.id);
            await this.emit({
                id: `note:${project}:${n.id}:${n.updated_at}`, kind: n.updated_at === n.created_at ? 'comment.created' : 'comment.edited', project, thread: {
                    project, number: item.iid, kind
                }, discussion: d.id, actor: n.author, receivedAt: n.updated_at, body: n.body, noteId: n.id, own: own || d.notes.some(x => x.author.id === this.ctx.user.id), replyToSelf: earlier, mention: mentionsUser(n.body, this.ctx.user.username), url: item.web_url, data: { note_id: n.id, system: n.system }
            });
        }
    }
    private async merges(only: string | null): Promise<void> {
        const since = new Date(this.now() - this.ctx.config.ownMergeWindow).toISOString();
        const rows = only === null
            ? await this.ctx.api.list<MergeRequest>('/merge_requests', { query: { scope: 'created_by_me', state: 'merged', updated_after: since } })
            : await this.ctx.api.list<MergeRequest>(MR, { params: { project: only }, query: {
                    state: 'merged', author_id: this.ctx.user.id, updated_after: since
                } });
        const watched = this.ctx.state.memory<Merged[]>('merged', []).filter(x => only !== null && x.expires > this.now() && x.project !== only);
        for (const mr of rows) {
            if (mr.author.id !== this.ctx.user.id || !mr.merged_at)
                continue;
            const expires = Date.parse(mr.merged_at) + this.ctx.config.ownMergeWindow;
            if (expires <= this.now())
                continue;
            const project = only ?? (await this.ctx.scope.discover(mr.project_id))?.path_with_namespace;
            if (!project)
                continue;
            for (const sha of new Set([mr.merge_commit_sha, mr.squash_commit_sha, mr.sha].filter((s): s is string => !!s)))
                watched.push({
                    project, iid: mr.iid, sha, expires
                });
        }
        this.ctx.state.remember('merged', watched);
    }
    private async reviewing(project: string, since: string): Promise<void> {
        const rows = await this.ctx.api.list<MergeRequest>(MR, { params: { project }, query: {
                reviewer_username: this.ctx.user.username, state: 'all', updated_after: since, order_by: 'updated_at', sort: 'asc'
            } });
        if (this.pass % 10 === 0) {
            const open = await this.ctx.api.list<MergeRequest>(MR, { params: { project }, query: { reviewer_username: this.ctx.user.username, state: 'opened' } });
            rows.push(...open);
            const hot = this.ctx.state.memory<Record<string, Watch>>('hot', {});
            for (const [key, w] of Object.entries(hot))
                if (w.project === project && !w.own && !open.some(m => m.iid === w.iid && m.sha === w.sha))
                    delete hot[key];
            this.ctx.state.remember('hot', hot);
        }
        for (let mr of rows) {
            const key = `review:${project}!${mr.iid}`;
            const before = this.ctx.state.memory<Marker | null>(key, null);
            if (before && before.sha !== mr.sha) {
                mr = await this.ctx.api.request<MergeRequest>('GET', MR + '/:iid', { params: { project, iid: mr.iid } });
                await this.emit({
                    id: `head:${project}:${mr.iid}:${(before.revision ?? 0) + 1}:${before.sha}:${mr.sha}`, kind: 'mr.head_changed', project, thread: {
                        project, number: mr.iid, kind: 'mr'
                    }, receivedAt: mr.updated_at, sha: mr.sha, data: {
                        old_sha: before.sha, new_sha: mr.sha, head_pipeline: mr.head_pipeline
                    }
                });
            }
            // Closing has its own actor; merge_user is absent on a closed MR.
            if (before && before.state !== mr.state && ['merged', 'closed'].includes(mr.state))
                await this.emit({
                    id: `mr.${mr.state}:${project}:${mr.iid}:${mr.merge_commit_sha ?? mr.sha}`, kind: `mr.${mr.state}`, project, thread: {
                        project, number: mr.iid, kind: 'mr'
                    }, actor: mr.state === 'closed' ? mr.closed_by ?? undefined : mr.merge_user, receivedAt: mr.updated_at, sha: mr.sha, data: {
                        merge_commit_sha: mr.merge_commit_sha, squash_commit_sha: mr.squash_commit_sha, merge_user: mr.merge_user
                    }
                });
            this.ctx.state.remember(key, {
                sha: mr.sha, state: mr.state, updated: mr.updated_at, revision: (before?.revision ?? 0) + (before && (before.sha !== mr.sha || before.state !== mr.state) ? 1 : 0)
            });
            const hot = this.ctx.state.memory<Record<string, Watch>>('hot', {});
            for (const [key, w] of Object.entries(hot))
                if (w.project === project && w.iid === mr.iid && !w.own && (mr.state !== 'opened' || mr.sha !== w.sha))
                    delete hot[key];
            this.ctx.state.remember('hot', hot);
            if (mr.state === 'opened') {
                if (!mr.head_pipeline)
                    mr = await this.ctx.api.request<MergeRequest>('GET', MR + '/:iid', { params: { project, iid: mr.iid } });
                this.watch(project, mr, false);
            }
        }
    }
    private async branch(entry: string): Promise<void> {
        const at = entry.lastIndexOf(':');
        const p = await this.ctx.scope.watch(entry.slice(0, at));
        const project = p.path_with_namespace, branch = entry.slice(at + 1);
        const head = await this.ctx.api.request<{
            commit: {
                id: string;
                author_name?: string;
                committer_name?: string;
            };
        }>('GET', '/projects/:project/repository/branches/:branch', { params: { project, branch } });
        const key = `branch:${project}:${branch}`;
        const before = this.ctx.state.memory<{
            sha: string;
            revision: number;
        } | null>(key, null);
        const revision = (before?.revision ?? 0) + (before && before.sha !== head.commit.id ? 1 : 0);
        if (before && before.sha !== head.commit.id) {
            const merge = this.ctx.state.memory<Merged[]>('merged', []).find(x => x.project === project && x.sha === head.commit.id && x.expires > this.now());
            await this.emit({
                id: `branch:${project}:${branch}:${revision}:${before.sha}:${head.commit.id}`, kind: 'branch.moved', project, channel: 'branches', receivedAt: new Date(this.now()).toISOString(), sha: head.commit.id, data: {
                    branch, old_sha: before.sha, new_sha: head.commit.id, commit: head.commit, merge_request_iid: merge?.iid
                }
            });
        }
        this.ctx.state.remember(key, { sha: head.commit.id, revision });
    }
    private async threads(project: string, kind: string, since: string): Promise<void> {
        const rows = await this.ctx.api.list<MergeRequest>(`/projects/:project/${kind}`, { params: { project }, query: {
                state: 'all', updated_after: since, order_by: 'updated_at', sort: 'asc'
            } });
        for (const item of rows) {
            const k = kind === 'issues' ? 'issue' : 'mr';
            const key = `thread:${project}:${k}:${item.iid}`;
            const prior = this.ctx.state.memory<Marker | null>(key, null);
            const eventKind = prior?.state !== item.state ? item.state === 'opened' ? (item.created_at >= since ? 'opened' : prior ? 'reopened' : 'edited') : item.state : 'edited';
            if (!prior || prior.updated !== item.updated_at)
                await this.emit({
                    id: `${key}:${item.updated_at}`, kind: `${k}.${eventKind}`, project, thread: {
                        project, number: item.iid, kind: k
                    }, actor: item.state === 'merged' ? item.merge_user : item.state === 'closed' ? item.closed_by ?? undefined : item.author, receivedAt: item.updated_at, title: item.title, body: item.description, url: item.web_url, own: item.author.id === this.ctx.user.id
                });
            await this.notes(project, item, k, since, item.author.id === this.ctx.user.id);
            this.ctx.state.remember(key, {
                sha: item.sha, state: item.state, updated: item.updated_at
            });
        }
    }
    private async pipelines(project: string, since: string, ownOnly = false): Promise<void> {
        const rows = await this.ctx.api.list<Pipeline>('/projects/:project/pipelines', { params: { project }, query: {
                updated_after: since, order_by: 'updated_at', sort: 'asc'
            } });
        const own = Object.values(this.ctx.state.memory<Record<string, Own>>('own', {})).filter(x => this.ctx.scope.event(x.project_id)?.path_with_namespace === project);
        const merges = this.ctx.state.memory<Merged[]>('merged', []).filter(x => x.project === project && x.expires > this.now());
        const c = this.ctx.config;
        for (const row of rows) {
            const p = await this.ctx.api.request<Pipeline>('GET', '/projects/:project/pipelines/:pipeline', { params: { project, pipeline: row.id } });
            const mr = own.find(m => m.sha === p.sha || p.ref === `refs/merge-requests/${m.iid}/head`);
            const merged = merges.find(m => m.sha === p.sha);
            const interest = c.pipelineScope.includes('own-mrs') && mr ? 'own-mr' : c.pipelineScope.includes('own-merges') && merged ? 'own-merge' : ownOnly ? null : c.pipelineScope.includes('users') && c.pipelineUsers.includes(p.user?.username ?? '') ? 'user' : c.pipelineScope.includes('refs') && c.pipelineRefs.includes(p.ref) ? 'ref' : null;
            if (!interest)
                continue;
            if (mr && interest === 'own-mr' && inflight.has(p.status))
                this.watch(project, { ...mr, head_pipeline: p }, true);
            await this.pipeline(project, p, interest, interest === 'own-mr' ? mr?.iid : undefined, !!mr && interest === 'own-mr');
        }
    }
    private async pipeline(project: string, p: Pipeline, interest: string, iid?: number, own = false): Promise<void> {
        if (!terminal.has(p.status))
            return;
        const c = this.ctx.config;
        const jobs = await this.ctx.api.list<Job>('/projects/:project/pipelines/:pipeline/jobs', { params: { project, pipeline: p.id } });
        const failed = jobs.filter(j => j.status === 'failed');
        const details: Record<string, unknown>[] = [];
        for (const [index, j] of failed.entries())
            details.push({
                id: j.id, name: j.name, stage: j.stage, failure_reason: j.failure_reason, web_url: j.web_url, ...(index < 3 && c.eventLogBytes ? { log_tail: bound(await this.ctx.api.request<string>('GET', '/projects/:project/jobs/:job/trace', { params: { project, job: j.id }, tailBytes: c.eventLogBytes, cleanTrace: true }), c.eventLogBytes, true) } : {})
            });
        const common = {
            project, receivedAt: p.updated_at ?? new Date(this.now()).toISOString(), sha: p.sha, own, interest, url: p.web_url, ...(iid ? { thread: {
                    project, number: iid, kind: 'mr' as const
                } } : { channel: 'pipelines' as const })
        };
        // A pipeline's triggering user is not the actor of its completion. Tagging
        // that user fromSelf would mute the agent's own failures.
        if (c.pipelineStatuses.includes(p.status))
            await this.emit({
                ...common, id: `pipeline:${project}:${p.id}:${p.status}:${p.updated_at ?? jobs.map(j => `${j.id}-${j.status}`).sort().join(",")}`, kind: 'pipeline.finished', status: p.status, data: {
                    pipeline_id: p.id, sha: p.sha, ref: p.ref, status: p.status, source: p.source, interest, failed_jobs: details
                }
            });
        for (const j of jobs)
            if (c.jobStatuses.includes(j.status) && c.jobPatterns.some(pattern => glob(j.name, pattern)))
                await this.emit({
                    ...common, id: `job:${project}:${j.id}:${j.status}`, kind: 'job.finished', status: j.status, job: j.name, data: {
                        job_id: j.id, name: j.name, stage: j.stage, failure_reason: j.failure_reason, web_url: j.web_url
                    }
                });
    }
}
