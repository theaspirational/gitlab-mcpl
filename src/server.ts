/** MCPL server pipeline ported from github-mcpl @7958055. GitHub's large
 * dual-comment/thread-kind knowledge cache is replaced by GitLab discussions
 * carrying the reply relation and explicit !/# channel kinds. */
import { McplConnection, ManifestTracker, type FeatureSetsUpdateParams, type McplInitializeParams, type JsonRpcRequest, type JsonRpcNotification } from '@animalabs/mcpl-core';
import { CapabilityGrant } from './grant.js';
import { McplRpcError, capabilityDenied } from './errors.js';
import { buildFeatureSets, buildServerCapabilities } from './feature-sets.js';
import { ChannelRegistry } from './channels.js';
import { callTool, TOOL_DEFINITIONS } from './tools.js';
import { rollbackComments } from './tools-comments.js';
import { type ToolContext, parseThread, string, base, params } from './tool-support.js';
import { featureSetForTool, channelId, type NormalizedEvent, type ToolResult, type ThreadRef, type Note } from './types.js';
import { tagsFor } from './tags.js';
import { renderEvent, renderData } from './content.js';
export class GitLabMcplServer {
    readonly grant: CapabilityGrant;
    readonly manifest: ManifestTracker;
    private conn: McplConnection | null = null;
    private mcpl = false;
    private channels: ChannelRegistry | null = null;
    private sent = new Set<string>();
    private eventQueue: Promise<unknown> = Promise.resolve();
    onReady?: () => void;
    constructor(readonly context: ToolContext) {
        this.grant = new CapabilityGrant(buildFeatureSets(context.config));
        this.manifest = new ManifestTracker(buildServerCapabilities(context.config));
    }
    get eventsEnabled(): boolean { return this.mcpl && !!this.conn && this.context.config.featureSets.includes('gitlab.events') && this.grant.isFeatureSetSelected('gitlab.events') && (this.grant.has('pushEvents') || this.grant.has('channels.incoming')); }
    private egress(conn: McplConnection, path: string): boolean { return this.conn === conn && this.eventsEnabled && this.grant.has(path); }
    async serve(conn: McplConnection): Promise<void> {
        if (this.conn)
            throw new Error('Only one host connection at a time');
        conn.on('error', () => this.context.logger.warn('Host connection error'));
        this.conn = conn;
        this.mcpl = false;
        this.grant.reset();
        this.sent.clear();
        this.channels = new ChannelRegistry({ send: (m, p) => conn.sendRequest(m, p) }, () => this.conn === conn && this.mcpl && this.grant.has('channels.register'), () => this.egress(conn, 'channels.incoming'));
        let detach: (() => void) | undefined;
        try {
            const first = await conn.nextMessage();
            if (first.type !== 'request' || first.request.method !== 'initialize') {
                conn.close();
                return;
            }
            const p = first.request.params as McplInitializeParams | undefined;
            this.mcpl = p?.capabilities?.experimental?.mcpl !== undefined;
            conn.sendResponse(first.request.id, {
                protocolVersion: '2024-11-05', serverInfo: { name: 'gitlab-mcpl', version: '0.1.0' }, capabilities: { tools: {}, ...(this.mcpl ? { experimental: { mcpl: this.manifest.snapshot() } } : {}) }
            });
            const initialized = await conn.nextMessage();
            if (initialized.type !== 'notification' || initialized.notification.method !== 'notifications/initialized') {
                conn.close();
                return;
            }
            if (this.mcpl)
                detach = this.manifest.attach({ sendNotification: (m, p) => conn.sendNotification(m, p) }, { announcedRevision: this.manifest.revision });
            while (!conn.isClosed) {
                const msg = await conn.nextMessage();
                if (msg.type === 'request')
                    await this.request(msg.request, conn);
                else
                    await this.notification(msg.notification);
            }
        }
        catch (e) {
            if ((e as Error).name !== 'ConnectionClosedError')
                this.context.logger.warn('Connection ended unexpectedly');
        }
        finally {
            detach?.();
            this.conn = null;
            this.channels = null;
            this.mcpl = false;
            this.grant.reset();
        }
    }
    private requireMcpl(): void {
        if (!this.mcpl)
            throw new McplRpcError(-32601, 'Method requires MCPL negotiation');
    }
    private require(path: string): void {
        this.requireMcpl();
        if (!this.grant.has(path))
            throw capabilityDenied(path);
    }
    private toolAvailable(name: string): boolean {
        const set = featureSetForTool(name);
        return !!set && this.context.config.featureSets.includes(set) && !this.context.config.toolsDeny.includes(name);
    }
    private listedTools() { return TOOL_DEFINITIONS.filter(t => this.toolAvailable(t.name) && (this.mcpl ? this.grant.toolAllowed(t.name) : t.name !== 'merge_at_sha')); }
    private ctx(): ToolContext {
        return {
            ...this.context, onEvent: this.onEvent, touch: async (t, title) => {
                // Events and channel lifecycle obey the event scope (GITLAB_PROJECTS),
                // even if reads allow '*'. A channel is not write authority:
                // publication goes through the comment tool and scope.write.
                try {
                    await this.context.scope.watch(t.project);
                }
                catch {
                    return;
                }
                try {
                    await this.channels?.ensureThread(t, title);
                }
                catch {
                    this.context.logger.warn('Channel registration deferred after tool touch');
                }
            }
        };
    }
    private async checkpoint(): Promise<{
        checkpoint: string;
        parent: string | null;
    }> {
        const c = this.context.state.createCheckpoint();
        await this.context.state.flush();
        return { checkpoint: c.id, parent: c.parent };
    }
    private async tool(name: unknown, args: unknown): Promise<ToolResult> {
        if (typeof name !== 'string' || !this.toolAvailable(name))
            throw new McplRpcError(-32601, `Unknown or disabled tool: ${String(name)}`);
        if (this.mcpl && !this.grant.toolAllowed(name))
            throw capabilityDenied(featureSetForTool(name)!);
        if (name === 'merge_at_sha' && !this.mcpl)
            throw capabilityDenied('gitlab.merge requires an explicit MCPL grant');
        const result = await callTool(name, args, this.ctx());
        if (!result.isError && featureSetForTool(name) === 'gitlab.comments' && this.mcpl) {
            try {
                return { ...result, state: await this.checkpoint() };
            }
            catch {
                return { isError: true, content: [...result.content, { type: 'text', text: 'Write succeeded, but checkpoint persistence failed. Do not retry the write.' }] };
            }
        }
        return result;
    }
    private async request(r: JsonRpcRequest, conn: McplConnection): Promise<void> {
        try {
            conn.sendResponse(r.id, await this.dispatch(r.method, (r.params ?? {}) as Record<string, unknown>));
        }
        catch (e) {
            if (e instanceof McplRpcError)
                conn.sendError(r.id, e.code, e.message, e.data);
            else
                conn.sendError(r.id, -32603, e instanceof Error ? e.message : 'Request failed');
        }
    }
    private async notification(n: JsonRpcNotification): Promise<void> {
        try {
            if (n.method === 'featureSets/update' && this.mcpl)
                this.grant.apply(n.params as FeatureSetsUpdateParams, 'notification');
            if (n.method === 'channels/publish')
                await this.dispatch(n.method, (n.params ?? {}) as Record<string, unknown>);
        }
        catch {
            this.context.logger.warn('Notification refused', { method: n.method });
        }
    }
    private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case 'ping': return {};
            case 'tools/list': return { tools: this.listedTools() };
            case 'tools/call': return this.tool(p.name, p.arguments ?? {});
            case 'featureSets/update': {
                this.requireMcpl();
                const wasEnabled = this.eventsEnabled;
                const result = this.grant.apply(p as unknown as FeatureSetsUpdateParams, 'request');
                if (!wasEnabled && this.eventsEnabled)
                    this.onReady?.();
                return result;
            }
            case 'mcpl/manifest':
                this.requireMcpl();
                return this.manifest.handleManifestRequest();
            case 'channels/list':
                this.require('channels.register');
                return { channels: this.channels!.list() };
            case 'channels/open': {
                this.require('channels.lifecycle');
                let id = p.channelId;
                if (id === undefined) {
                    const address = p.address as Partial<ThreadRef> | undefined;
                    if (p.type !== 'gitlab' || !address || typeof address.project !== 'string' || !Number.isSafeInteger(address.number) || !['mr', 'issue'].includes(address.kind ?? ''))
                        throw new McplRpcError(-32602, 'Expected GitLab channel id or {project,number,kind} address');
                    id = channelId(address as ThreadRef);
                }
                if (typeof id !== 'string')
                    throw new McplRpcError(-32602, 'channelId must be a string');
                const readonly = /^gitlab:(.+)@(pipelines|branches)$/.exec(id);
                if (readonly) {
                    const project = await this.context.scope.watch(readonly[1]);
                    const channel = await this.channels!.ensure({
                        id: `gitlab:${project.path_with_namespace}@${readonly[2]}`, type: 'gitlab', label: `${project.path_with_namespace} ${readonly[2]}`, direction: 'inbound', address: { project: project.path_with_namespace, kind: readonly[2] }
                    });
                    if (!channel)
                        throw capabilityDenied('channels.register');
                    return {
                        channel, history: [], historyTruncated: false
                    };
                }
                const t = parseThread(id);
                const project = await this.context.scope.watch(t.project);
                t.project = project.path_with_namespace;
                const history = p.history as {
                    limit?: unknown;
                    beforeMessageId?: unknown;
                    sinceLastSeen?: unknown;
                } | undefined;
                if (history !== undefined) {
                    if (typeof history.limit !== 'number' || !Number.isSafeInteger(history.limit) || history.limit < 0)
                        throw new McplRpcError(-32602, 'history.limit must be a nonnegative integer');
                    if (history.sinceLastSeen)
                        throw new McplRpcError(-32602, 'sinceLastSeen history is not supported; use beforeMessageId');
                    // History returns note bodies on request, with no incoming event:
                    // that is a read, so it needs READ authority on top of the event
                    // scope that admits the channel. Refused before the channel is
                    // registered and before any note is fetched; opening without
                    // history (or with limit 0) stays an event-scope operation.
                    if (history.limit > 0)
                        await this.context.scope.read(project.id);
                }
                const descriptor = await this.channels!.ensureThread(t);
                if (!descriptor)
                    throw capabilityDenied('channels.register');
                if (history === undefined)
                    return { channel: descriptor };
                if (history.limit === 0)
                    return {
                        channel: descriptor, history: [], historyTruncated: false
                    };
                let notes = await this.context.api.list<Note>(base(t) + '/notes', { params: params(t), query: { order_by: 'created_at', sort: 'asc' } });
                if (history.beforeMessageId !== undefined) {
                    const anchor = String(history.beforeMessageId);
                    const numeric = /^\d+$/.test(anchor) ? Number(anchor) : Number(/^note:.*:([0-9]+):/.exec(anchor)?.[1]);
                    if (!Number.isSafeInteger(numeric))
                        throw new McplRpcError(-32602, 'beforeMessageId must identify a note');
                    notes = notes.filter(n => n.id < numeric);
                }
                const limit = Math.min(history.limit as number, 100);
                return {
                    channel: descriptor, history: notes.slice(-limit).map(n => ({
                        channelId: descriptor.id, messageId: String(n.id), author: { id: String(n.author.id), name: n.author.username }, timestamp: n.created_at, content: renderData(n)
                    })), historyTruncated: notes.length > limit
                };
            }
            case 'channels/close':
                this.require('channels.lifecycle');
                return { closed: !!this.channels!.get(String(p.channelId)) };
            case 'channels/typing':
                this.require('channels.typing');
                return {};
            case 'channels/publish': return this.publish(p);
            case 'state/checkpoint':
                this.requireComments(p);
                return this.checkpoint();
            case 'state/rollback':
                this.requireComments(p);
                return rollbackComments(string(p, 'checkpoint'), this.ctx());
            default: throw new McplRpcError(-32601, `Method not found: ${method}`);
        }
    }
    private requireComments(p: Record<string, unknown>): void {
        this.requireMcpl();
        if (p.featureSet !== 'gitlab.comments' || !this.context.config.featureSets.includes('gitlab.comments') || !this.grant.isFeatureSetActive('gitlab.comments'))
            throw capabilityDenied('gitlab.comments');
    }
    private async publish(p: Record<string, unknown>): Promise<unknown> {
        this.require('channels.publish');
        this.requireComments({ featureSet: 'gitlab.comments' });
        if (p.stream === true)
            throw new McplRpcError(-32602, 'Streaming publication is not supported');
        const channel = string(p, 'channelId');
        const descriptor = this.channels!.get(channel);
        if (!descriptor)
            throw new McplRpcError(-32023, `Unknown channel: ${channel}`);
        if (descriptor.direction !== 'bidirectional')
            throw new McplRpcError(-32602, 'Pipeline/branch channels are read-only');
        const content = p.content;
        if (!Array.isArray(content))
            throw new McplRpcError(-32602, 'content: expected text blocks');
        const text = content.map(block => {
            if (!block || block.type !== 'text' || typeof block.text !== 'string')
                throw new McplRpcError(-32602, 'Only text publication is supported');
            return block.text;
        }).join('\n');
        if (!text.trim())
            return { delivered: false, reason: 'empty-content' };
        const name = p.threadId === undefined ? 'comment' : 'reply_in_thread';
        // Tool deny applies to this alternate write carrier too.
        const result = await this.tool(name, {
            thread: channel, body: text, ...(p.threadId === undefined ? {} : { thread_id: p.threadId })
        });
        if (result.isError)
            throw new McplRpcError(-32602, (result.content[0] as {
                text: string;
            }).text);
        return { delivered: true, ...result };
    }
    readonly onEvent = (e: NormalizedEvent): Promise<boolean> => {
        const run = this.eventQueue.then(() => this.event(e));
        this.eventQueue = run.catch(() => { });
        return run;
    };
    private async event(e: NormalizedEvent): Promise<boolean> {
        const conn = this.conn;
        if (!conn || !this.eventsEnabled || !this.context.scope.ready)
            return false;
        // The all-projects token notice has no project; everything else is
        // re-checked here, so excluded projects never reach a channel.
        if (!(this.context.config.allProjects && e.kind === 'token.expiring' && e.project === '*'))
            try {
                await this.context.scope.watch(e.project);
            }
            catch {
                return true;
            } // outside event scope is intentionally discarded
        const { tags, metadata } = tagsFor(e, this.context.user, this.context.config.maintainers);
        const content = renderEvent(e);
        let delivered = false, failed = false;
        const incomingKey = e.id + ':incoming', pushKey = e.id + ':push';
        if (this.egress(conn, 'channels.incoming')) {
            if (this.sent.has(incomingKey))
                delivered = true;
            else
                try {
                    if (await this.channels!.deliver(e, tags, metadata, content)) {
                        this.sent.add(incomingKey);
                        delivered = true;
                    }
                    else
                        failed = true;
                }
                catch {
                    failed = true;
                }
        }
        if (this.egress(conn, 'pushEvents')) {
            if (this.sent.has(pushKey))
                delivered = true;
            else
                try {
                    const result = await conn.sendRequest('push/event', {
                        featureSet: 'gitlab.events', eventId: e.id, timestamp: e.receivedAt, origin: {
                            source: 'gitlab', kind: e.kind, metadata, channelId: e.thread ? channelId(e.thread) : `gitlab:${e.project}@${e.channel ?? 'pipelines'}`, ...metadata
                        }, tags, payload: { content }
                    });
                    if ((result as {
                        accepted?: boolean;
                    })?.accepted !== true)
                        failed = true;
                    else {
                        this.sent.add(pushKey);
                        delivered = true;
                    }
                }
                catch {
                    failed = true;
                }
        }
        while (this.sent.size > 10000)
            this.sent.delete(this.sent.values().next().value!);
        return delivered && !failed;
    }
}
