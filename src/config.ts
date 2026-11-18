import { readFileSync, statSync } from 'node:fs';
import { TOOLS_BY_FEATURE_SET, type FeatureSetName } from './types.js';
export interface Config {
    url: string;
    token: string;
    ca?: string;
    expectUsername?: string;
    timeout: number;
    projects: string[];
    /** GITLAB_PROJECTS=*: EVENT scope is every visible project minus `projectsExclude`.
     * It never grants reads (`readAllow`) or writes (`writeAllow`). */
    allProjects: boolean;
    projectsExclude: string[];
    /** GITLAB_WRITE_ALLOW: the only write authority in all-projects mode. Empty in list mode, where GITLAB_PROJECTS is the write list. */
    writeAllow: string[];
    readAllow: string[];
    featureSets: FeatureSetName[];
    toolsDeny: string[];
    mrTargetAllow: string[];
    sourcePattern: string;
    forceDraft: boolean;
    retryRefs: string[];
    mergeTargetAllow: string[];
    mergeAuthorOnly: boolean;
    mergeRequirePipeline: boolean;
    mergeRemoveSource: boolean;
    diffMax: number;
    diffFileMax: number;
    logMax: number;
    fileMax: number;
    searchMax: number;
    sources: string[];
    branchWatch: string[];
    eventLogBytes: number;
    hotInterval: number;
    pipelineProjects: string[];
    pipelineScope: string[];
    pipelineUsers: string[];
    pipelineRefs: string[];
    pipelineStatuses: string[];
    ownMergeWindow: number;
    jobPatterns: string[];
    jobStatuses: string[];
    pollInterval: number;
    overlap: number;
    maintainers: string[];
    systemNotes: 'drop' | 'keep';
    stateFile: string | null;
    logLevel: string;
}
/** Feature sets whose tools (or channel publication/rollback) change GitLab. */
export const WRITE_FEATURE_SETS: readonly FeatureSetName[] = ['gitlab.comments', 'gitlab.mr', 'gitlab.ci', 'gitlab.rebase', 'gitlab.merge'];
export class ConfigError extends Error {
    constructor(readonly problems: string[]) { super('Invalid environment:\n' + problems.map(p => '  - ' + p).join('\n')); this.name = 'ConfigError'; }
}
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
    const problems: string[] = [];
    const get = (key: string, d = '') => env[`GITLAB_${key}`]?.trim() ?? d;
    const list = (key: string, d = '') => get(key, d).split(',').map(x => x.trim()).filter(Boolean);
    const num = (key: string, d: number, min = 0, max = 10000000) => {
        const n = Number(get(key, String(d)));
        if (!Number.isSafeInteger(n) || n < min || n > max) {
            problems.push(`GITLAB_${key}: expected integer ${min}..${max}`);
            return d;
        }
        return n;
    };
    const bool = (key: string, d = false) => {
        const s = get(key, String(d));
        if (!['true', 'false'].includes(s))
            problems.push(`GITLAB_${key}: expected true or false`);
        return s === 'true';
    };
    const required = (key: string) => {
        const v = get(key);
        if (!v)
            problems.push(`GITLAB_${key}: required`);
        return v;
    };
    const allowHttp = bool('ALLOW_HTTP');
    let url: URL;
    try {
        url = new URL(required('URL'));
    }
    catch {
        problems.push('GITLAB_URL: invalid URL');
        url = new URL('https://invalid.invalid');
    }
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !allowHttp))
        problems.push('GITLAB_URL: expected HTTPS URL without credentials/query/fragment');
    const file = required('TOKEN_FILE');
    let token = '', ca: string | undefined;
    try {
        if (!statSync(file).isFile() || (statSync(file).mode & 0o777) !== 0o600)
            problems.push('GITLAB_TOKEN_FILE: requires a regular mode-600 file');
        else
            token = readFileSync(file, 'utf8').trim();
        if (!token || /\s/.test(token))
            problems.push('GITLAB_TOKEN_FILE: empty or invalid token');
    }
    catch {
        problems.push('GITLAB_TOKEN_FILE: cannot read secret file');
    }
    if (get('CA_FILE'))
        try {
            ca = readFileSync(get('CA_FILE'), 'utf8');
        }
        catch {
            problems.push('GITLAB_CA_FILE: cannot read PEM file');
        }
    const listed = list('PROJECTS');
    // Opt-in all-projects mode is exactly `*`: never a glob, never mixed with a list.
    const allProjects = listed.includes('*');
    const projects = allProjects ? [] : listed;
    if (allProjects && listed.length > 1)
        problems.push('GITLAB_PROJECTS: * cannot be combined with other entries; use GITLAB_PROJECTS_EXCLUDE');
    if (!allProjects && !projects.length)
        problems.push('GITLAB_PROJECTS: required');
    if (projects.some(p => !/^(?:[1-9]\d*|[^\s:*#!?%]+\/[^\s:*#!?%]+)$/.test(p)))
        problems.push('GITLAB_PROJECTS: expected project paths or numeric ids, not groups/globs (or exactly * for all-projects mode)');
    const projectsExclude = list('PROJECTS_EXCLUDE');
    if (projectsExclude.length && !allProjects)
        problems.push('GITLAB_PROJECTS_EXCLUDE: only valid with GITLAB_PROJECTS=*');
    if (projectsExclude.some(r => !/^(?:[1-9]\d*|[^\s:*#!?%]+\/(?:\*|[^\s:*#!?%]+))$/.test(r)))
        problems.push('GITLAB_PROJECTS_EXCLUDE: expected project paths, numeric ids or group/* prefixes');
    const featureSets = list('FEATURE_SETS', 'gitlab.events,gitlab.read') as FeatureSetName[];
    if (featureSets.some(x => !Object.hasOwn(TOOLS_BY_FEATURE_SET, x)))
        problems.push('GITLAB_FEATURE_SETS: unknown or deferred set');
    // `*` widens events only. Write authority in that mode is this explicit
    // list; a bare `*` is refused so no single character grants every project.
    const writeAllow = list('WRITE_ALLOW');
    if (env.GITLAB_WRITE_ALLOW !== undefined && !allProjects)
        problems.push('GITLAB_WRITE_ALLOW: only valid with GITLAB_PROJECTS=* (with a project list, GITLAB_PROJECTS is the write list)');
    if (writeAllow.some(r => !/^(?:[1-9]\d*|[^\s:*#!?%]+\/(?:\*|[^\s:*#!?%]+))$/.test(r)))
        problems.push('GITLAB_WRITE_ALLOW: expected project paths, numeric ids or group/* prefixes (a bare * is refused)');
    const mergeTargetAllow = list('MERGE_TARGET_ALLOW');
    if (featureSets.includes('gitlab.merge') && !mergeTargetAllow.length)
        problems.push('GITLAB_MERGE_TARGET_ALLOW: required for gitlab.merge');
    const sources = list('EVENT_SOURCES', 'todos,own-mrs,pipelines');
    if (sources.some(x => ![
        'todos', 'own-mrs', 'pipelines', 'reviewing', 'branches', 'threads'
    ].includes(x)))
        problems.push('GITLAB_EVENT_SOURCES: unknown source');
    for (const key of Object.keys(env))
        if (key.startsWith('GITLAB_WEBHOOK_') || key === 'GITLAB_AGENT_USERS' || key === 'GITLAB_SHARED_ACCOUNT')
            problems.push(`${key}: unsupported in polling-only, numeric-self v1`);
    const hotInterval = num('HOT_POLL_INTERVAL_MS', 20000);
    if (hotInterval && hotInterval < 10000)
        problems.push('GITLAB_HOT_POLL_INTERVAL_MS: floor 10000, or 0');
    const systemNotes = get('SYSTEM_NOTES', 'drop');
    if (!['drop', 'keep'].includes(systemNotes))
        problems.push('GITLAB_SYSTEM_NOTES: expected drop or keep');
    const pipelineScope = list('PIPELINE_SCOPE', 'own-mrs,own-merges');
    if (pipelineScope.some(x => !['own-mrs', 'own-merges', 'users', 'refs'].includes(x)))
        problems.push('GITLAB_PIPELINE_SCOPE: unknown interest rule');
    if (allProjects) {
        // Nothing widens silently: every scope that used to default to the project
        // list must now be stated, and unbounded per-project sources are refused.
        if (sources.some(x => ['reviewing', 'threads'].includes(x)))
            problems.push('GITLAB_EVENT_SOURCES: reviewing and threads are per-project sources and cannot be combined with GITLAB_PROJECTS=*');
        const writeSets = featureSets.filter(x => WRITE_FEATURE_SETS.includes(x));
        if (writeSets.length && !writeAllow.length)
            problems.push(`GITLAB_WRITE_ALLOW: required for ${writeSets.join(',')} with GITLAB_PROJECTS=* (* widens events only; name the projects that may be written)`);
        if (featureSets.includes('gitlab.read') && env.GITLAB_READ_ALLOW === undefined)
            problems.push('GITLAB_READ_ALLOW: must be set explicitly with GITLAB_PROJECTS=* (use * to read every visible project)');
        if (sources.includes('pipelines') && pipelineScope.some(x => ['users', 'refs'].includes(x)) && !list('PIPELINE_PROJECTS').length)
            problems.push('GITLAB_PIPELINE_PROJECTS: required for users/refs pipeline scope with GITLAB_PROJECTS=*');
        for (const key of ['MR_TARGET_ALLOW', 'MERGE_TARGET_ALLOW'])
            if (list(key).some(x => !x.includes(':')))
                problems.push(`GITLAB_${key}: entries must be project:branch with GITLAB_PROJECTS=*`);
    }
    const logLevel = get('LOG_LEVEL', 'info');
    if (!['debug', 'info', 'warn', 'error'].includes(logLevel))
        problems.push('GITLAB_LOG_LEVEL: invalid level');
    const toolsDeny = list('TOOLS_DENY');
    const knownTools = Object.values(TOOLS_BY_FEATURE_SET).flat() as readonly string[];
    if (toolsDeny.some(t => !knownTools.includes(t)))
        problems.push('GITLAB_TOOLS_DENY: unknown tool');
    for (const key of ['PIPELINE_STATUSES', 'JOB_EVENT_STATUSES'])
        if (list(key, 'failed,success').some(s => !['success', 'failed', 'canceled', 'skipped'].includes(s)))
            problems.push(`GITLAB_${key}: expected final statuses success,failed,canceled,skipped`);
    const result: Config = {
        url: url.href.replace(/\/$/, ''), token, ca,
        expectUsername: get('EXPECT_USERNAME') || undefined, timeout: num('HTTP_TIMEOUT_MS', 30000, 1, 300000), projects, allProjects, projectsExclude, writeAllow: allProjects ? writeAllow : [],
        readAllow: list('READ_ALLOW', projects.join(',')), featureSets, toolsDeny,
        mrTargetAllow: list('MR_TARGET_ALLOW'), sourcePattern: get('MR_SOURCE_PATTERN'), forceDraft: bool('MR_FORCE_DRAFT'), retryRefs: list('CI_RETRY_REFS'),
        mergeTargetAllow, mergeAuthorOnly: bool('MERGE_AUTHOR_ONLY', true), mergeRequirePipeline: bool('MERGE_REQUIRE_PIPELINE', true), mergeRemoveSource: bool('MERGE_REMOVE_SOURCE_BRANCH'),
        diffMax: num('DIFF_MAX_BYTES', 200000, 1), diffFileMax: num('DIFF_FILE_MAX_BYTES', 40000, 1), logMax: num('JOB_LOG_MAX_BYTES', 65536, 1), fileMax: num('FILE_MAX_BYTES', 200000, 1), searchMax: num('SEARCH_FANOUT_MAX', 10, 1, 30),
        sources, branchWatch: list('BRANCH_WATCH'), eventLogBytes: num('PIPELINE_EVENT_LOG_BYTES', 0, 0, 65536), hotInterval,
        pipelineProjects: list('PIPELINE_PROJECTS', projects.join(',')), pipelineScope, pipelineUsers: list('PIPELINE_USERS'), pipelineRefs: list('PIPELINE_REFS'), pipelineStatuses: list('PIPELINE_STATUSES', 'failed,success'),
        ownMergeWindow: num('OWN_MERGE_WINDOW_MS', 21600000, 1, 604800000), jobPatterns: list('JOB_EVENT_PATTERN'), jobStatuses: list('JOB_EVENT_STATUSES', 'failed'), pollInterval: num('POLL_INTERVAL_MS', 60000, 30000, 3600000), overlap: num('POLL_OVERLAP_MS', 120000, 1000, 3600000),
        maintainers: list('MAINTAINERS'), systemNotes: systemNotes as 'drop' | 'keep', stateFile: get('STATE_FILE') || null, logLevel,
    };
    if (problems.length)
        throw new ConfigError(problems);
    return result;
}
export function glob(value: string, pattern: string): boolean {
    return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);
}
/** READ_ALLOW / PROJECTS_EXCLUDE rule forms, matched only against the
 * server-returned id and canonical path: exact path, numeric id, `prefix/*`
 * (subgroups included) and, where the caller's validation admits it, `*`. */
export function projectMatches(p: { id: number; path_with_namespace: string }, rules: readonly string[]): boolean {
    return rules.some(rule => rule === '*' || rule === String(p.id) || rule === p.path_with_namespace || (rule.endsWith('/*') && p.path_with_namespace.startsWith(rule.slice(0, -1))));
}
export function targetAllowed(project: string, branch: string, entries: readonly string[]): boolean {
    return entries.includes(branch) || entries.includes(`${project}:${branch}`);
}
