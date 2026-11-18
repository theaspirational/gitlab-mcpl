import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from './harness.js';
test('operator docs explain conditional CI enablement and tagged runners', () => {
    for (const file of ['README.md', 'docs/live-test.md']) {
        const text = readFileSync(file, 'utf8');
        assert.match(text, /builds_access_level/);
        assert.match(text, /[Ii]f runners require tags/);
    }
});
test('log tails remain opt-in by default; runnable deployment examples opt into 4096', () => {
    assert.equal(config().eventLogBytes, 0);
    for (const file of ['README.md', 'deploy/gitlab-mcpl.env.example', 'examples/live-test.env', 'examples/list.env', 'examples/writes-all-projects.env', 'examples/all-projects.env'])
        assert.match(readFileSync(file, 'utf8'), /GITLAB_PIPELINE_EVENT_LOG_BYTES=4096/);
});
