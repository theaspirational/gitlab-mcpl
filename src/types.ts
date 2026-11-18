import type { ContentBlock } from '@animalabs/mcpl-core';
export interface CheckpointRecord {
    id: string;
    parent: string | null;
    createdAt: string;
}
/** A comment this server created after a checkpoint — rollback deletes it. */
export interface CreatedComment {
    repo: string;
    commentId: number;
    /** Review-comment deletes use a different REST path than issue comments. */
    review: boolean;
}
/** A comment this server edited after a checkpoint — rollback restores `previousBody`. */
export interface EditedComment {
    repo: string;
    commentId: number;
    previousBody: string;
    review: boolean;
}
/**
 * A comment this server deleted after a checkpoint. GitHub has no undelete, so
 * rollback can only report it; `previousBody` is kept so the receipt can say
 * what was lost without asking GitHub for a comment that is gone.
 */
export interface DeletedComment {
    repo: string;
    commentId: number;
    previousBody: string;
    review: boolean;
}
/**
 * Whether a checkpoint can still be rolled back to (§8.7).
 *
 *   - `live` — it is `current` or one of its ancestors;
 *   - `abandoned` — an earlier rollback moved `current` off its branch, so its
 *     undo records are spent and the state it named cannot be reconstructed;
 *   - `unknown` — no such checkpoint.
 *
 * Both of the latter are §8.7's "pruned or unknown" and answer `-32005`.
 */
export type CheckpointStatus = 'live' | 'abandoned' | 'unknown';
/** What rollback has to undo, newest first. */
export interface RollbackPlan {
    created: CreatedComment[];
    edited: EditedComment[];
}
/** The durable JSON at GITHUB_STATE_FILE, written atomically by the state store. */
export interface StateSnapshot {
    checkpoints: CheckpointRecord[];
    current: string | null;
    created: Record<string, CreatedComment[]>;
    edited: Record<string, EditedComment[]>;
    /**
     * Every list of the repositories polled has delivered what changed before
     * this: the start of the last pass whose every delivery was accepted, or
     * where a read it stopped stopped, if earlier; before any pass has
     * delivered, the window the first pass read. A list with no cursor of its
     * own in `pollCursors` starts here, such as one of a repository newly in
     * GITHUB_REPOS, or every list of a state file written before `pollCursors`
     * existed. Read as a whole second.
     */
    lastPollAt: string | null;
    /**
     * Each poll list's own cursor, for the repositories the last pass read.
     * **Additive**: a state file without it is still a valid version-1 snapshot.
     */
    pollCursors: Record<string, PollCursor>;
    /**
     * Per list, the rows announced as new (id → created_at), so a row read
     * again inside its list's window, after a stopped read, a refused delivery
     * or in the second a pass started in, is not announced as new twice.
     * Written when the row's event is accepted, and pruned to the rows created
     * inside the window when a pass delivers. **Additive**, like `pollCursors`.
     */
    pollNew: Record<string, Record<string, string>>;
    /** Ring of the last {@link POLL_DEDUP_RING} `<kind>:<id>:<updated_at>` keys for duplicate-delivery suppression. */
    pollKeys: string[];
    /**
     * The head sha last polled for each open pull request, keyed
     * `<owner>/<name>#<number>` for head-change detection. An open pull-request row seen
     * again is `pull.synchronize` only when its head moved away from what is
     * recorded here; bounded by {@link POLL_HEAD_MEMORY}.
     */
    pollHeads: Record<string, string>;
}
/** How many poll keys the dedup ring remembers. */
export const POLL_DEDUP_RING = 2000;
/**
 * How many pull-request heads the poll state remembers for head-change detection. One
 * entry is a channel id and a sha; the oldest is dropped past this, which at
 * worst makes a `synchronize` look like a first sighting and drop one row that
 * the comment rows of the same pass already describe.
 */
export const POLL_HEAD_MEMORY = 200;
/**
 * The state interface ToolContext carries, backed by the state file.
 *
 * `recordDeletedComment` and `checkpointStatus` share this interface with
 * the other state operations: tools and rollback use the same state type,
 * without casts to record a deletion or inspect a checkpoint's §8.7 status.
 */
export interface StateStore {
    createCheckpoint(): CheckpointRecord;
    current(): string | null;
    lineage(): CheckpointRecord[];
    recordCreatedComment(comment: CreatedComment): void;
    recordEditedComment(comment: EditedComment): void;
    /** A delete rollback can only report; GitHub cannot undo it. */
    recordDeletedComment(comment: DeletedComment): void;
    /** Null when the checkpoint is unknown or abandoned (§8: -32005). */
    rollback(checkpointId: string): RollbackPlan | null;
    /** Why `rollback` returned null: `unknown`, or `abandoned` by an earlier one. */
    checkpointStatus(checkpointId: string): CheckpointStatus;
    lastPollAt(): string | null;
    setLastPollAt(when: string): void;
    /** Each poll list's own cursor, keyed `<owner>/<name>:<list>`. */
    pollCursors(): Readonly<Record<string, PollCursor>>;
    /** Replace them all: a list left out has no cursor of its own. */
    setPollCursors(cursors: Record<string, PollCursor>): void;
    /** Per list, the rows announced as new in its window (`StateSnapshot.pollNew`). */
    polledNew(): Readonly<Record<string, Record<string, string>>>;
    setPolledNew(rows: Record<string, Record<string, string>>): void;
    /** True when the key was already seen; otherwise records it in the ring and returns false. */
    seenPollKey(key: string): boolean;
    /**
     * What the last pass recorded for this thread's row, or null: an open pull
     * request's head sha for head-change detection, `closed` for a closed one, an issue's
     * state-and-text fingerprint ({@link polledMarker} in normalize.ts).
     */
    polledHead(channel: string): string | null;
    /** Record the marker this pass saw for a thread's row. */
    setPolledHead(channel: string, sha: string): void;
    snapshot(): StateSnapshot;
    /** Atomic write of the snapshot; a no-op without GITHUB_STATE_FILE. */
    flush(): Promise<void>;
}
export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}
/** A Logger that writes `[gitlab-mcpl] <tag> <level> <message> <fields>` to stderr. */
export function stderrLogger(tag = 'gitlab-mcpl'): Logger {
    const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
        const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
        process.stderr.write(`[${tag}] ${level} ${message}${suffix}\n`);
    };
    return {
        debug: (m, f) => write('debug', m, f),
        info: (m, f) => write('info', m, f),
        warn: (m, f) => write('warn', m, f),
        error: (m, f) => write('error', m, f),
    };
}
/** A Logger that drops everything — tests that assert on no output. */
export function silentLogger(): Logger {
    const noop = (): void => { };
    return {
        debug: noop, info: noop, warn: noop, error: noop
    };
}
export type ThreadKind = 'issue' | 'mr';
export interface PollCursor {
    since: string;
    resumeAt?: string;
}
export interface User {
    id: number;
    username: string;
    name?: string;
}
export interface Project {
    id: number;
    path_with_namespace: string;
    web_url?: string;
}
export interface Pipeline {
    id: number;
    sha: string;
    ref: string;
    status: string;
    source?: string;
    user?: User;
    updated_at?: string;
    web_url?: string;
}
export interface Job {
    id: number;
    name: string;
    status: string;
    stage: string;
    ref: string;
    failure_reason?: string;
    web_url?: string;
    pipeline?: Pipeline;
}
export interface MergeRequest {
    id: number;
    iid: number;
    project_id: number;
    source_project_id: number;
    target_project_id: number;
    title: string;
    description: string;
    state: string;
    sha: string;
    author: User;
    source_branch: string;
    target_branch: string;
    draft: boolean;
    merge_when_pipeline_succeeds: boolean;
    detailed_merge_status: string;
    head_pipeline?: Pipeline | null;
    updated_at: string;
    created_at: string;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    squash_commit_sha?: string | null;
    merge_user?: User;
    closed_by?: User | null;
    merge_error?: string;
    web_url: string;
}
export interface Note {
    id: number;
    body: string;
    author: User;
    system: boolean;
    created_at: string;
    updated_at: string;
    resolvable?: boolean;
    resolved?: boolean;
}
export interface Discussion {
    id: string;
    individual_note: boolean;
    notes: Note[];
}
export interface Diff {
    old_path: string;
    new_path: string;
    diff: string;
    too_large?: boolean;
    collapsed?: boolean;
}
export interface Todo {
    id: number;
    action_name: string;
    project?: Project | null;
    target_type: string;
    target?: MergeRequest | null;
    author: User;
    body: string;
    target_url: string;
    created_at: string;
}
export interface ThreadRef {
    project: string;
    number: number;
    kind: ThreadKind;
}
export function channelId(t: ThreadRef): string { return `gitlab:${t.project}${t.kind === 'mr' ? '!' : '#'}${t.number}`; }
export interface NormalizedEvent {
    id: string;
    kind: string;
    project: string;
    actor?: User;
    receivedAt: string;
    thread?: ThreadRef;
    channel?: 'pipelines' | 'branches';
    discussion?: string;
    body?: string;
    title?: string;
    url?: string;
    sha?: string;
    noteId?: number;
    own?: boolean;
    replyToSelf?: boolean;
    mention?: boolean;
    todoAction?: string;
    status?: string;
    interest?: string;
    job?: string;
    data?: Record<string, unknown>;
}
export interface ToolResult {
    content: ContentBlock[];
    isError?: boolean;
    state?: {
        checkpoint: string;
        parent: string | null;
    };
}
export const TOOLS_BY_FEATURE_SET = {
    'gitlab.events': [],
    'gitlab.read': [
        'get_merge_request', 'list_merge_requests', 'list_discussions', 'list_pipelines', 'get_pipeline', 'get_job_log', 'search_code', 'get_file', 'list_tree', 'get_issue'
    ],
    'gitlab.comments': ['comment', 'reply_in_thread', 'edit_own_comment', 'delete_own_comment', 'upsert_sticky_comment'],
    'gitlab.mr': ['create_merge_request', 'edit_merge_request', 'request_review'],
    'gitlab.ci': ['retry_pipeline', 'retry_job'],
    'gitlab.rebase': ['rebase_merge_request'],
    'gitlab.merge': ['merge_at_sha'],
} as const;
export type FeatureSetName = keyof typeof TOOLS_BY_FEATURE_SET;
export function featureSetForTool(tool: string): FeatureSetName | undefined {
    return (Object.keys(TOOLS_BY_FEATURE_SET) as FeatureSetName[]).find(k => (TOOLS_BY_FEATURE_SET[k] as readonly string[]).includes(tool));
}
