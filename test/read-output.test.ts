import test from 'node:test';
import assert from 'node:assert/strict';
import { readOutput } from '../src/read-output.js';
test('large and deeply nested metadata is bounded and reports clipping', () => {
    for (const full of [false, true]) {
        const result = readOutput(Array.from({ length: 1000 }, (_, id) => ({ id, description: '🙂'.repeat(10000), user: { id: 7, username: 'agent', avatar_url: 'secret' } })), full);
        assert.equal(result.output_truncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65000);
        assert.ok((result.data as unknown[]).length < 100);
    }
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { user: deep };
    assert.equal(readOutput(deep).output_truncated, true);
});
