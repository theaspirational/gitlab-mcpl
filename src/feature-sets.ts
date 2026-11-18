// Port of sibling's declarations, ontology and capability manifest builder.
import type { FeatureSetDeclaration, McplManifest, TagOntology } from '@animalabs/mcpl-core';
import type { Config } from './config.js';
import { CORE_TAGS } from './tags.js';
export const TAG_ONTOLOGY: TagOntology = {
    coreTags: CORE_TAGS, open: true,
    keyed: {
        'gitlab:mr': { desc: 'MR lifecycle or head/approval change', values: [
                'opened', 'edited', 'head-changed', 'merged', 'closed', 'approval-changed'
            ] },
        'gitlab:ci': { desc: 'Pipeline/job status', values: ['success', 'failed', 'canceled', 'skipped', 'manual'] },
        'gitlab:pipeline': { desc: 'Why a pipeline interests the agent', values: ['own-mr', 'own-merge', 'user', 'ref', 'reviewing'] },
        'gitlab:job': { desc: 'Watched job name' }, 'gitlab:todo': { desc: 'GitLab to-do action' }, 'gitlab:actor': { desc: 'Actor classification', values: ['maintainer'] },
        'gitlab:branch': { desc: 'Watched branch head moved', values: ['moved'] }, 'gitlab:token': { desc: 'Token expiry warning', values: ['expiring'] }, 'gitlab:issue': { desc: 'Issue lifecycle' },
    },
    defaultTreatment: [
        { tagsAny: ['chat:from-self'], behavior: 'mute' },
        { tagsAny: [
                'chat:mention', 'chat:reply', 'gitlab:todo=review_requested', 'gitlab:ci=failed', 'gitlab:mr=head-changed', 'gitlab:token=expiring'
            ], behavior: 'immediate' },
        { tagsAny: ['chat:ambient', 'gitlab:ci=success'], behavior: { throttle: { perMs: 120000 } } },
    ],
};
export function buildFeatureSets(c: Config): Record<string, FeatureSetDeclaration> {
    return Object.fromEntries(c.featureSets.map(name => [name, {
            description: `${name}: configured GitLab connector surface`, uses: name === 'gitlab.events' ? ['pushEvents'] : name === 'gitlab.comments' ? ['tools', 'channels.publish'] : ['tools'], rollback: name === 'gitlab.comments', ...(name === 'gitlab.events' ? { tagOntology: TAG_ONTOLOGY } : {})
        }]));
}
export function buildServerCapabilities(c: Config): McplManifest {
    return {
        version: '0.5', pushEvents: true, channels: {
            register: true, lifecycle: true, publish: true, incoming: true, typing: true
        }, featureSets: buildFeatureSets(c)
    };
}
