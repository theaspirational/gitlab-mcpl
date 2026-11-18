import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, FakeGitLab, config, PROJECT, SELF, SHA, until } from './harness.js';
import type { NormalizedEvent, ToolResult } from '../src/types.js';
const event: NormalizedEvent = {
    id: 'note:test', kind: 'comment.created', project: PROJECT, thread: {
        project: PROJECT, number: 3, kind: 'mr'
    }, actor: { id: 8, username: 'human' }, receivedAt: '2026-11-16T12:00:00Z', body: 'hello', discussion: 'd'.repeat(40), replyToSelf: true
};
const writeConfig = () => config({ featureSets: ['gitlab.events', 'gitlab.read', 'gitlab.comments', 'gitlab.merge'], mergeTargetAllow: ['main'] });
test('MCPL handshake, fail-closed grant, notification cannot widen, conflict fails closed', async () => {
    const h = await harness();
    try {
        const init = await h.initialize() as {
            capabilities: {
                experimental?: unknown;
            };
        };
        assert.ok(init.capabilities.experimental);
        assert.deepEqual(await h.host.sendRequest('tools/list', {}), { tools: [] });
        await assert.rejects(h.host.sendRequest('tools/call', { name: 'get_merge_request', arguments: { project: PROJECT, iid: 3 } }));
        h.host.sendNotification('featureSets/update', { effectiveCapabilities: ['tools'], enabled: ['gitlab.read'] });
        assert.deepEqual(await h.host.sendRequest('tools/list', {}), { tools: [] });
        await h.grant(['tools']);
        assert.ok((await h.host.sendRequest('tools/list', {}) as {
            tools: unknown[];
        }).tools.length > 0);
        await assert.rejects(h.grant(['tools'], { deniedCapabilities: ['tools'] }));
        assert.deepEqual(await h.host.sendRequest('tools/list', {}), { tools: [] });
        assert.deepEqual(h.violations, []);
    }
    finally {
        await h.close();
    }
});
test('plain MCP tools work with configured ceiling, but merge requires MCPL grant and never appears', async () => {
    const h = await harness(await new FakeGitLab(writeConfig()).init());
    try {
        const init = await h.initialize(false) as {
            capabilities: {
                experimental?: unknown;
            };
        };
        assert.equal(init.capabilities.experimental, undefined);
        const tools = await h.host.sendRequest('tools/list', {}) as {
            tools: {
                name: string;
            }[];
        };
        assert.ok(!tools.tools.some(t => t.name === 'merge_at_sha'));
        assert.ok(!(await h.host.sendRequest('tools/call', { name: 'get_merge_request', arguments: { project: PROJECT, iid: 3 } }) as ToolResult).isError);
        await assert.rejects(h.host.sendRequest('tools/call', { name: 'merge_at_sha', arguments: {
                project: PROJECT, iid: 3, sha: SHA
            } }));
        assert.equal(await h.server.onEvent(event), false);
        assert.equal(h.saw.length, 0);
        await assert.rejects(h.host.sendRequest('channels/list', {}));
    }
    finally {
        await h.close();
    }
});
test('independent push-only / channels-only egress, GitLab thread ids and numeric metadata', async () => {
    for (const cap of [['pushEvents'], ['channels.register', 'channels.incoming']]) {
        const h = await harness();
        try {
            await h.initialize();
            await h.grant(cap);
            assert.equal(await h.server.onEvent(event), true);
            assert.equal(h.saw.filter(r => r.method === 'push/event').length, cap.includes('pushEvents') ? 1 : 0);
            const incoming = h.saw.find(r => r.method === 'channels/incoming');
            if (incoming) {
                const p = incoming.params as {
                    messages: {
                        threadId: string;
                        channelId: string;
                        metadata: {
                            fromSelf: boolean;
                        };
                    }[];
                };
                assert.equal(p.messages[0].threadId, 'd:' + 'd'.repeat(40));
                assert.equal(p.messages[0].channelId, `gitlab:${PROJECT}!3`);
                assert.equal(p.messages[0].metadata.fromSelf, false);
            }
            assert.deepEqual(h.violations, []);
        }
        finally {
            await h.close();
        }
    }
});
test('grant reduction during queued registration prevents incoming and push', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => release = r);
    const h = await harness(undefined, { hold: r => r.method === 'channels/register' ? held : undefined });
    try {
        await h.initialize();
        await h.grant();
        const delivery = h.server.onEvent(event);
        await until(() => h.saw.some(r => r.method === 'channels/register'));
        await h.grant([]);
        release();
        assert.equal(await delivery, false);
        assert.equal(h.saw.filter(r => ['channels/incoming', 'push/event'].includes(r.method)).length, 0);
        assert.deepEqual(h.violations, []);
    }
    finally {
        release();
        await h.close();
    }
});
test('partial egress acceptance retries only the failed path; foreign events dropped', async () => {
    const opts = { rejectPush: true };
    const h = await harness(undefined, opts);
    try {
        await h.initialize();
        await h.grant();
        assert.equal(await h.server.onEvent(event), false);
        opts.rejectPush = false;
        assert.equal(await h.server.onEvent(event), true);
        assert.equal(h.saw.filter(r => r.method === 'channels/incoming').length, 1);
        assert.equal(h.saw.filter(r => r.method === 'push/event').length, 2);
        assert.equal(await h.server.onEvent({
            ...event, id: 'foreign', project: 'foreign/repo'
        }), true);
        assert.equal(h.saw.length, 4);
    }
    finally {
        await h.close();
    }
});
test('comment tool and channel publish share neutralisation, checkpoint, rollback, and deny fences', async () => {
    const f = await new FakeGitLab(writeConfig()).init();
    const h = await harness(f);
    try {
        await h.initialize();
        await h.grant();
        const cp = await h.host.sendRequest('state/checkpoint', { featureSet: 'gitlab.comments' }) as {
            checkpoint: string;
        };
        const write = await h.host.sendRequest('tools/call', { name: 'comment', arguments: { thread: `${PROJECT}!3`, body: '/merge' } }) as ToolResult;
        assert.ok(write.state);
        assert.equal(f.notes[0].body, '/\u200bmerge');
        await h.host.sendRequest('channels/publish', {
            channelId: `gitlab:${PROJECT}!3`, threadId: 'd:' + 'd'.repeat(40), content: [{ type: 'text', text: '/approve' }]
        });
        assert.equal(f.notes.at(-1)?.body, '/\u200bapprove');
        h.host.sendNotification('channels/publish', { channelId: `gitlab:${PROJECT}!3`, content: [{ type: 'text', text: 'notification' }] });
        await h.host.sendRequest('ping', {});
        assert.equal(f.notes.length, 3);
        const rollback = await h.host.sendRequest('state/rollback', { featureSet: 'gitlab.comments', checkpoint: cp.checkpoint }) as {
            success: boolean;
        };
        assert.equal(rollback.success, true);
        assert.equal(f.notes.length, 0);
        f.config.toolsDeny = ['comment'];
        await assert.rejects(h.host.sendRequest('channels/publish', { channelId: `gitlab:${PROJECT}!3`, content: [{ type: 'text', text: 'blocked' }] }));
        await assert.rejects(h.host.sendRequest('state/rollback', { featureSet: 'gitlab.comments', checkpoint: 'unknown' }));
    }
    finally {
        await h.close();
    }
});
test('merge needs selected feature set as well as tools grant', async () => {
    const f = await new FakeGitLab(writeConfig()).init();
    const h = await harness(f);
    try {
        await h.initialize();
        await h.grant(['tools'], { enabled: ['gitlab.read'] });
        await assert.rejects(h.host.sendRequest('tools/call', { name: 'merge_at_sha', arguments: {
                project: PROJECT, iid: 3, sha: SHA
            } }));
        await h.grant(['tools'], { enabled: ['gitlab.merge'] });
        assert.ok(!(await h.host.sendRequest('tools/call', { name: 'merge_at_sha', arguments: {
                project: PROJECT, iid: 3, sha: SHA
            } }) as ToolResult).isError);
    }
    finally {
        await h.close();
    }
});
test('blanket tools capability does not implicitly grant merge', async () => {
    const h = await harness(await new FakeGitLab(writeConfig()).init());
    try {
        await h.initialize();
        await h.grant(['tools']);
        const result = await h.host.sendRequest('tools/list', {}) as {
            tools: {
                name: string;
            }[];
        };
        assert.ok(!result.tools.some(t => t.name === 'merge_at_sha'));
        await assert.rejects(h.host.sendRequest('tools/call', { name: 'merge_at_sha', arguments: {
                project: PROJECT, iid: 3, sha: SHA
            } }));
    }
    finally {
        await h.close();
    }
});
test('channel open by address, bounded history, readonly project channels', async () => {
    const h = await harness(await new FakeGitLab(writeConfig()).init());
    try {
        await h.initialize();
        await h.grant();
        h.fake.notes = [{
                id: 1, body: 'old', author: SELF, system: false, created_at: '2026-01-01', updated_at: '2026-01-01'
            }];
        const opened = await h.host.sendRequest('channels/open', {
            type: 'gitlab', address: {
                project: PROJECT, number: 3, kind: 'mr'
            }, history: { limit: 1 }
        }) as {
            history: {
                messageId: string;
            }[];
        };
        assert.equal(opened.history[0].messageId, '1');
        await h.host.sendRequest('channels/open', { channelId: `gitlab:${PROJECT}@pipelines` });
        await assert.rejects(h.host.sendRequest('channels/publish', { channelId: `gitlab:${PROJECT}@pipelines`, content: [{ type: 'text', text: 'no' }] }));
    }
    finally {
        await h.close();
    }
});
