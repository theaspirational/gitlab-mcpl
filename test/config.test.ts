import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, ConfigError } from '../src/config.js';
test('configuration defaults are read-only, polling-only, merge and retry are opt-in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-env-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'do-not-print-this', { mode: 0o600 });
    const env = {
        GITLAB_URL: 'https://gitlab.invalid', GITLAB_TOKEN_FILE: file, GITLAB_PROJECTS: 'team/sub/repo'
    };
    try {
        const c = readConfig(env);
        assert.deepEqual(c.featureSets, ['gitlab.events', 'gitlab.read']);
        assert.equal(c.pollInterval, 60000);
        assert.equal(c.hotInterval, 20000);
        assert.deepEqual(c.mergeTargetAllow, []);
        assert.deepEqual(c.retryRefs, []);
        for (const bad of [
            { GITLAB_URL: 'http://host' }, { GITLAB_POLL_INTERVAL_MS: '0' }, { GITLAB_POLL_INTERVAL_MS: '29999' }, { GITLAB_HOT_POLL_INTERVAL_MS: '9999' }, { GITLAB_FEATURE_SETS: 'gitlab.merge' }, { GITLAB_FEATURE_SETS: 'gitlab.review' }, { GITLAB_TOOLS_DENY: 'merg' }, { GITLAB_EVENT_SOURCES: 'webhooks' }, { GITLAB_AGENT_USERS: 'other' }, { GITLAB_SHARED_ACCOUNT: 'true' }, { GITLAB_WEBHOOK_PORT: '8080' }, { GITLAB_MERGE_AUTHOR_ONLY: 'yes' }
        ])
            assert.throws(() => readConfig({ ...env, ...bad }), ConfigError);
        assert.equal(readConfig({
            ...env, GITLAB_ALLOW_HTTP: 'true', GITLAB_URL: 'http://localhost'
        }).url, 'http://localhost');
        chmodSync(file, 0o644);
        assert.throws(() => readConfig(env), /mode-600/);
        try {
            readConfig({
                ...env, GITLAB_POLL_INTERVAL_MS: '1', GITLAB_HOT_POLL_INTERVAL_MS: '1'
            });
        }
        catch (e) {
            const err = e as ConfigError;
            assert.ok(err.problems.length >= 3);
            assert.ok(!err.message.includes('do-not-print-this'));
        }
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('mention fallback excludes tilde, backtick, indented and unterminated code', async () => {
    const { mentionsUser } = await import('../src/normalize.js');
    for (const body of ['```\n@example-user\n```', '~~~md\n@example-user\n~~~', '````\n@example-user', '    @example-user', '`@example-user`'])
        assert.equal(mentionsUser(body, 'example-user'), false, body);
    assert.equal(mentionsUser('hello @example-user!', 'example-user'), true);
    assert.equal(mentionsUser('@example-user-other', 'example-user'), false);
});
