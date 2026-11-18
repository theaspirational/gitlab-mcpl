import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { tagsFor } from '../src/tags.js';
import { SELF, PROJECT } from './harness.js';
type Policy = {
    name: string;
    match: {
        source: string;
        metadataTrue?: string[];
        tagsAny?: string[];
    };
    behavior: string;
};
for (const name of ['read-only-list', 'list', 'all-projects', 'writes-all-projects'])
    test(`${name} recipe: self first, other regular users never bot-filtered`, () => {
        const recipe = JSON.parse(readFileSync(new URL(`../examples/recipe-${name}.json`, import.meta.url), 'utf8'));
        const policies = recipe.modules.wake.policies as Policy[];
        assert.deepEqual(policies[0].match.metadataTrue, ['fromSelf']);
        assert.equal(policies[0].behavior, 'skip');
        assert.ok(!JSON.stringify(recipe).includes('chat:from-bot'));
        assert.ok(!recipe.mcpServers.gitlab.enabledFeatureSets.includes('gitlab.merge'));
        const { tags, metadata } = tagsFor({
            id: 'pipeline', kind: 'pipeline.finished', project: PROJECT, receivedAt: 'now', status: 'failed', interest: 'own-mr', own: true
        }, SELF, []);
        const policy = policies.find(p => (!p.match.metadataTrue || p.match.metadataTrue.some(k => metadata[k as keyof typeof metadata] === true)) && (!p.match.tagsAny || p.match.tagsAny.some(t => tags.includes(t))));
        assert.equal(policy?.behavior, 'always');
    });

for (const name of ['all-projects', 'writes-all-projects', 'live-test'])
    test(`${name} env parses safely with explicit authority and merge disabled`, () => {
        const text = readFileSync(new URL(`../examples/${name}.env`, import.meta.url), 'utf8');
        const env = Object.fromEntries(text.split('\n').filter(line => /^GITLAB_/.test(line)).map(line => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)];
        }));
        const dir = mkdtempSync(join(tmpdir(), 'gitlab-recipe-'));
        try {
            const token = join(dir, 'token');
            writeFileSync(token, 'fixture-token', { mode: 0o600 });
            const c = readConfig({ ...env, GITLAB_TOKEN_FILE: token });
            assert.ok(!c.featureSets.includes('gitlab.merge'));
            assert.ok(c.readAllow.length);
            assert.ok(c.stateFile?.includes(name));
            if (name !== 'live-test') {
                assert.equal(c.allProjects, true);
                assert.ok(!c.sources.includes('reviewing') && !c.sources.includes('threads'));
                if (c.featureSets.includes('gitlab.mr')) {
                    assert.deepEqual(c.writeAllow, ['TEST_GROUP/TEST_PROJECT']);
                    assert.deepEqual(c.mrTargetAllow, ['TEST_GROUP/TEST_PROJECT:main']);
                }
                else
                    assert.deepEqual(c.writeAllow, []);
            }
            else {
                assert.deepEqual(c.projects, ['TEST_GROUP/TEST_PROJECT']);
                assert.ok(c.sources.includes('reviewing'));
            }
        }
        finally { rmSync(dir, { recursive: true, force: true }); }
    });
