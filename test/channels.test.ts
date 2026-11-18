import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/channels.js';
import { PROJECT } from './harness.js';
test('queued touch cannot overwrite a concurrently acknowledged merge state', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => release = r);
    let changes = 0;
    const registry = new ChannelRegistry({ async send(method, p) { const data = p as {
            channels?: {
                id: string;
            }[];
            updated?: {
                id: string;
            }[];
        }; if (method === 'channels/changed') {
            changes++;
            await held;
        } return { results: (data.channels ?? data.updated)!.map(d => ({ id: d.id, accepted: true })) }; } }, () => true, () => true);
    const thread = {
        project: PROJECT, number: 3, kind: 'mr' as const
    };
    await registry.ensureThread(thread, 'title');
    const merged = registry.ensureThread(thread, undefined, 'merged');
    const touch = registry.ensureThread(thread);
    release();
    await Promise.all([merged, touch]);
    assert.equal((registry.get(`gitlab:${PROJECT}!3`)!.metadata as {
        state: string;
    }).state, 'merged');
    assert.equal(changes, 1);
});
test('missing channel acknowledgement is not acceptance', async () => {
    const registry = new ChannelRegistry({ async send() { return { results: [] }; } }, () => true, () => true);
    assert.equal(await registry.ensureThread({
        project: PROJECT, number: 3, kind: 'mr'
    }), undefined);
    assert.equal(registry.list().length, 0);
});
