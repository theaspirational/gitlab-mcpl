// Ported from github-mcpl: per-channel queue, lazy registration, acknowledged
// descriptors only, and capability recheck immediately before delivery.
import { type ChannelDescriptor, type ContentBlock, type ChannelsRegisterResult, type ChannelsIncomingParams, type ChannelsIncomingResult } from '@animalabs/mcpl-core';
import { channelId, type ThreadRef, type NormalizedEvent } from './types.js';
export interface HostConnection {
    send(method: string, params: unknown): Promise<unknown>;
}
export class ChannelRegistry {
    private records = new Map<string, ChannelDescriptor>();
    private queue = new Map<string, Promise<void>>();
    constructor(private host: HostConnection, private canRegister: () => boolean, private canDeliver: () => boolean) { }
    list(): ChannelDescriptor[] { return [...this.records.values()]; }
    get(id: string): ChannelDescriptor | undefined { return this.records.get(id); }
    async ensureThread(t: ThreadRef, title?: string, state?: string): Promise<ChannelDescriptor | undefined> {
        const id = channelId(t);
        return this.queued(id, () => {
            const known = this.get(id);
            return {
                id, type: 'gitlab', label: title ? `${id} ${title.slice(0, 200)}` : known?.label ?? id, direction: 'bidirectional', address: t, metadata: { kind: t.kind, state: state ?? (known?.metadata as {
                        state?: string;
                    })?.state ?? 'opened' }
            };
        });
    }
    async ensure(d: ChannelDescriptor): Promise<ChannelDescriptor | undefined> {
        return this.queued(d.id, () => d);
    }
    private async queued(id: string, desired: () => ChannelDescriptor): Promise<ChannelDescriptor | undefined> {
        const previous = this.queue.get(id) ?? Promise.resolve();
        const run = previous.then(async () => {
            const d = desired();
            const known = this.records.get(id);
            if (known && JSON.stringify(known) === JSON.stringify(d))
                return known;
            if (!this.canRegister())
                return undefined;
            const result = await this.host.send(known ? 'channels/changed' : 'channels/register', known ? { updated: [d] } : { channels: [d] }) as ChannelsRegisterResult;
            if (!this.canRegister() || result?.results?.find(x => x.id === id)?.accepted !== true)
                return undefined;
            this.records.set(id, d);
            return d;
        });
        const tail = run.then(() => { }, () => { });
        this.queue.set(id, tail);
        try {
            return await run;
        }
        finally {
            if (this.queue.get(id) === tail)
                this.queue.delete(id);
        }
    }
    async deliver(e: NormalizedEvent, tags: string[], metadata: Record<string, unknown>, content: ContentBlock[]): Promise<boolean> {
        const d = e.thread ? await this.ensureThread(e.thread, e.title, e.kind.endsWith('.merged') ? 'merged' : e.kind.endsWith('.closed') ? 'closed' : /\.(opened|reopened)$/.test(e.kind) ? 'opened' : undefined) : await this.ensure({
            id: `gitlab:${e.project}@${e.channel ?? 'pipelines'}`, type: 'gitlab', label: `${e.project} ${e.channel ?? 'pipelines'}`, direction: 'inbound', address: { project: e.project, kind: e.channel ?? 'pipelines' }
        });
        if (!d || !this.canDeliver())
            return false;
        const incoming: ChannelsIncomingParams = { messages: [{
                    channelId: d.id, messageId: e.id, content, timestamp: e.receivedAt, author: { id: String(e.actor?.id ?? 'gitlab'), name: e.actor?.username ?? 'GitLab' }, ...(e.discussion ? { threadId: `d:${e.discussion}` } : {}), tags, metadata
                }] };
        const result = await this.host.send('channels/incoming', incoming) as ChannelsIncomingResult;
        return result?.results?.find(r => r.messageId === e.id)?.accepted === true;
    }
}
