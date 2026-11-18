# gitlab-mcpl

Polling [MCPL](https://github.com/anima-research/mcpl) connector for self-managed
GitLab. Node **≥22.12**, TypeScript, MIT. API fixtures target **GitLab 17.11, Free tier**; validate your own version.
Uses `@animalabs/mcpl-core` to expose scoped read/write tools and polling
events to an MCP/MCPL host. No webhook listener or GitLab SDK is required.

**Validation status:** automated fixture/API and real MCPL stream tests only.
No live GitLab instance was available; slow/unreachable startup has not been
verified live (only with local fixtures). Do not treat these tests as certification
of protected-branch behavior, GitLab timing, or your deployment permissions.
See [Design notes](#design-notes) for polling limitations.

## Run

```sh
npm ci --cache .npm-cache
npm run build
npm test
install -d -m 700 "$HOME/.config/gitlab-mcpl"
# Put your PAT in ~/.config/gitlab-mcpl/token without placing it in shell history.
chmod 600 "$HOME/.config/gitlab-mcpl/token"
export GITLAB_URL=https://example.gitlab.com
export GITLAB_TOKEN_FILE="$HOME/.config/gitlab-mcpl/token"
export GITLAB_PROJECTS=group/project
export GITLAB_EXPECT_USERNAME=example-user
export GITLAB_PIPELINE_EVENT_LOG_BYTES=4096
export GITLAB_STATE_FILE="$HOME/.config/gitlab-mcpl/state.json"
node dist/src/index.js --stdio
# Or: node dist/src/index.js --tcp 8787  (127.0.0.1 only, one host at a time)
```

### Scope examples

The run example above is **list mode**: `GITLAB_PROJECTS=group/project`.
To track bounded reviewer heads as well, use:

```sh
export GITLAB_PROJECTS=group/project,group/other-project
export GITLAB_READ_ALLOW=group/project,group/other-project
export GITLAB_EVENT_SOURCES=todos,own-mrs,pipelines,reviewing
export GITLAB_PIPELINE_EVENT_LOG_BYTES=4096
# List mode uses PROJECTS for write scope; leave WRITE_ALLOW and EXCLUDE unset.
```

For **all-projects events with excludes**, replace those scope settings with:

```sh
export GITLAB_PROJECTS='*'
export GITLAB_PROJECTS_EXCLUDE='private-group/*,group/excluded-project,1234'
export GITLAB_READ_ALLOW='group/*'
export GITLAB_FEATURE_SETS=gitlab.events,gitlab.read
export GITLAB_EVENT_SOURCES=todos,own-mrs,pipelines
export GITLAB_PIPELINE_EVENT_LOG_BYTES=4096
# Only if enabling write feature sets (api PAT required):
# export GITLAB_WRITE_ALLOW=group/project
# export GITLAB_MR_TARGET_ALLOW=group/project:main
```

Do not combine `*` with a project list. Excludes restrict events and writes,
not independently allowed reads. `reviewing` and `threads` require list mode.

Use a **dedicated regular user**, one process and one state file per account.
The token must have `read_api` for read/events, or `api` for any declared write
set. `write_repository` alone does not authenticate REST. Before serving, startup
validates local configuration, `/user` (including
`GITLAB_EXPECT_USERNAME`), PAT scopes via `/personal_access_tokens/self`, and
the state file's instance/numeric-user binding and initial persistence. These
fail fast so a wrong account, insufficient token or mismatched state cannot be
advertised as usable. A slow/unreachable identity or PAT endpoint therefore still
blocks/fails startup. `/version` diagnostics, project/subsidiary scope resolution
and persisted-watch revalidation run **after** stdio is attached or TCP listens;
`initialize`, `ping` and `tools/list` do not wait for them. Until project validation
finishes, event/write-scope operations return not-ready and authorize nothing;
explicit `GITLAB_READ_ALLOW` reads are independent. Every normal/hot poll waits
for successful scope and persisted-state validation, retrying on later passes.
Unvalidated persisted watches never drive pipeline reads or event delivery.
Tokens with fewer than 14 days remaining generate a warning and an event
when the host grants events. Rotate tokens out of band and restart; no automatic
rotation. Never put a PAT in an environment variable or command-line argument.

Plain MCP supports the configured tools **except merge**, but has no polling,
channels, push events, or rollback protocol. MCPL advertises its manifest only
when negotiated and grants **nothing** before a grant-bearing
`featureSets/update` Request. Notification-form updates can only reduce authority.
Comments declare both `tools` and `channels.publish`, matching the sibling's
contract; a tool-only MCPL host must grant both to enable that set.

## CI prerequisites

If the test project has CI/CD disabled, enable it in the project's
**Settings → General → Visibility, project features, permissions**
(`builds_access_level: enabled`) before testing pipelines. A runner must be
available to the project and permitted on the branch. If runners require tags,
set matching tags in each `.gitlab-ci.yml` job (or under `default`); otherwise
jobs may stay pending. Use your runner's actual tags.

Failure-event log tails are opt-in: `GITLAB_PIPELINE_EVENT_LOG_BYTES` defaults
to `0` (off); the examples use `4096`. ANSI controls and GitLab section markers
are stripped before the useful-text byte cap; ordinary runner prose remains.

## Tool surfaces

Default: **`gitlab.events,gitlab.read`**. Writes are explicit opt-ins.

| Feature set | Tools |
|---|---|
| `gitlab.events` | Polling events, no tools |
| `gitlab.read` | `get_merge_request`, `list_merge_requests`, `list_discussions`, `list_pipelines`, `get_pipeline`, `get_job_log`, `search_code`, `get_file`, `list_tree`, `get_issue` |
| `gitlab.comments` | `comment`, `reply_in_thread`, `edit_own_comment`, `delete_own_comment`, `upsert_sticky_comment` |
| `gitlab.mr` | `create_merge_request`, `edit_merge_request`, `request_review` |
| `gitlab.ci` | `retry_pipeline`, `retry_job` (currently fail closed; see below) |
| `gitlab.rebase` | `rebase_merge_request` |
| `gitlab.merge` | **`merge_at_sha` only**, off by default |

`gitlab.review` and `gitlab.issues` writes are deferred, not silently accepted.
There is no approve, raw API, repository-write, auto-merge, cancel-auto-merge,
merge-ref, or webhook surface.

Examples (tool arguments, before any host tool-name prefix):

```json
{"project":"group/project","iid":3,"include":"diff,discussions,approvals"}
{"project":"group/project","pipeline_id":123}
{"project":"group/project","job_id":456,"grep":"ERROR","context":2}
{"group":"group","query":"function_name","ref":"main"}
{"thread":"gitlab:group/project!3","body":"Update: tests passed."}
{"thread":"gitlab:group/project!3","thread_id":"d:0123456789abcdef0123456789abcdef01234567","body":"Reply"}
{"project":"group/project","iid":3,"draft":false}
```

MR channels are `gitlab:<nested/path>!<iid>`; issue channels use `#<iid>`.
Discussion threads are `d:<40-hex-id>`. `@pipelines` and `@branches` are read-only
project channels. Channels register lazily on an event, tool touch, or open.
`channels/open` accepts an id or `{project,number,kind:"mr"|"issue"}` address;
optional history is capped at 100 notes, with `beforeMessageId` support.
Opening a channel needs the project in event scope; history with a nonzero
limit is a read and additionally needs `GITLAB_READ_ALLOW` (refused otherwise,
before the channel is registered).
`sinceLastSeen` is explicitly unsupported. Typing is a granted no-op.

Comments are owned by **numeric user id**, never a username or bot flag.
Sticky comments use a simple `marker` key and only update this user's matching
note. MCPL comment writes return a checkpoint after the write. Rollback deletes
created notes and restores edited text; deleted notes cannot be undeleted and
are reported as irreversible. Rollback rechecks project scope and note ownership.
Failed undo work remains retryable; the journal stays intact during remote undo.

## Events and safety

The default sources are pending **and done** to-dos, own-MR notes/approvals,
and pipelines matching own MRs or recently merged own MRs. Reviewer heads,
reviewed-MR merge/close, watched branch heads, and full project threads are opt-in.
Hot polling follows active own/reviewer head pipelines.
`GITLAB_PROJECTS=*` opts in to events from every project the token can see,
minus `GITLAB_PROJECTS_EXCLUDE`; see [all-projects mode](docs/configuration.md#all-projects-mode-gitlab_projects).
`*` widens events only: reads still follow `GITLAB_READ_ALLOW`, and writes are
allowed only in projects named in `GITLAB_WRITE_ALLOW`, which `*` never implies.
Startup refuses any write feature set in that mode without `GITLAB_WRITE_ALLOW`.
It also requires an explicit `GITLAB_READ_ALLOW` and project-qualified target
allow-lists, and refuses the `reviewing` and `threads` sources. Failed pipeline events
include failed job ids, names, stages, URLs and reasons; up to three optional
bounded log tails. Watched jobs produce separate events.

Pipeline completion is **not** attributed to its triggering user: that would
incorrectly mute failures on the agent's own pipelines as `fromSelf`.
`chat:from-self` is numeric identity only. No agent-user/bot suppression exists.
[Recipes](examples/) show self-first wake policies with neutral placeholders.
Use `recipe-list.json` with `list.env` for bounded per-project reviewing;
`recipe-read-only-list.json` is a read-only list-mode host recipe.
The `recipe-all-projects.json` / `all-projects.env` and
`recipe-writes-all-projects.json` / `writes-all-projects.env` pairs use
`GITLAB_PROJECTS=*`, explicit read authority, and explicit write authority where
writes are enabled. Adapt placeholder paths and select the matching env via
`GITLAB_MCPL_ENV_FILE`; `gitlab.merge` stays off. All-projects recipes use to-dos
for reviewer assignment, not the unsupported per-project `reviewing`/`threads`
sources; use list mode for reviewer head tracking.

All HTTP requests pass a static method/template allow-list. Every outgoing
string is quick-action neutralised, including channel publish, descriptions,
and rollback restorations. All command-looking lines (`^\s*/\w`) get a zero-width
space after `/`; there is no bypass. Tool schemas reject arbitrary extra fields.
Redirects are refused and pagination never follows server-provided URLs.

Merge requires **all three**: configured `gitlab.merge`, nonempty
`GITLAB_MERGE_TARGET_ALLOW`, and an MCPL Request explicitly enabling
`gitlab.merge` (a blanket `tools` capability is insufficient). It checks author,
exact 40-hex head SHA, target, no existing auto-merge, successful head pipeline
by default, and `detailed_merge_status`. The only merge body fields are `sha`
and configured `should_remove_source_branch`. 401/403/405/409/422 have explained
refusals; 405/409/422 re-read state. There is **never an automatic merge retry**.
Attempts/outcomes are audited to stderr and state, with no rollback.

The SHA is checked atomically by GitLab. **Target, author and other preflight
conditions are not atomically pinned by GitLab's merge API**: concurrent MR
retargeting remains a deployment/reviewer concern. Account permissions outside
this connector are not restricted by it.

### CI retries fail closed on 17.11

`retry_pipeline` and `retry_job` currently refuse all requests, even with an
explicit ref allow-list. Pipeline completion can execute a human-armed auto-merge.
GitLab's worker considers associated MRs across projects, not just MRs visible
to this token; a visible-MR preflight cannot prove safety or prevent concurrent
arming. The retry HTTP routes are disabled too. Use GitLab directly for retries
until a server-side safety mechanism can uphold the connector's no-merge boundary.
No auto-merge is cancelled or modified by the connector.

## Configuration and operations

See [all environment variables](docs/configuration.md),
[deployment examples](deploy/), [Design notes](#design-notes), and the isolated
[live-test kit](docs/live-test.md) ([env](examples/live-test.env)).
Read scope is separate from write/event scope. In all-projects mode read,
write and event scope are three separate settings and none is derived from
another. Group code search fans out to
read-allowed projects because Free GitLab cannot do group blob search.

State includes note bodies needed for rollback, poll cursors, a 2,000-entry dedup
ring for other events, a separate set of still-pending/recent to-do identities, watched SHAs, discussion/reviewer markers and a 1,000-entry merge audit.
It is atomically replaced in mode 600. Protect its directory; do not share it
between processes. Missing/corrupt state starts empty with a warning (inherited
sibling behavior); expect replay and loss of rollback reach. State is bound at startup to the instance URL and numeric user id; mismatches
are refused. Never restore a state file from a different instance/user. Without a state file it is in memory.

The state file may outlive the configuration that wrote it. At load, before
every poll pass and before every hot poll, persisted hot pipeline watches are
revalidated against the **current** `GITLAB_EVENT_SOURCES` and event scope
(`GITLAB_PROJECTS`, or `*` minus `GITLAB_PROJECTS_EXCLUDE`) and dropped if
they fail; own-MR/own-merge interest sets and poll cursors of a disabled
source or an out-of-scope project are dropped at the first check. A source or
project enabled again later therefore starts from a fresh window rather than
catching up from its old cursor. If a scope decision cannot be made (GitLab
unreachable in all-projects mode), nothing is polled until it can.

GET retries are bounded (three attempts), respecting `Retry-After` or
`RateLimit-Reset`; delays over 60 seconds are returned as errors for later retry.
**Writes never retry automatically**. After a timeout, disconnect, or server 5xx,
inspect GitLab before repeating a write: it may have succeeded without an answer.
A crash between a successful write and journaling can also lose undo information.

Poll sources advance only after successful complete reads and accepted delivery;
failed sources retain their own cursor, including a persisted first-pass lower bound.
Pending to-do identities are retained until absent from a complete pending read
and older than the completed-to-do overlap window; they are not ring-evicted.
Notes pagination requires numeric `X-Next-Page` metadata (empty means last page);
missing or malformed metadata fails the source rather than silently truncating it. No polling runs without an event grant.
Each event can be delivered on **two paths**: `channels.incoming` and
`pushEvents`. Each path is deduped **separately**, not against the other path:
a host with both enabled shows the event **twice**. **Prefer `channels.incoming`** for channel-native delivery: explicitly select
`gitlab.events` and grant `channels.register` as well. The default
`gitlab.events` declaration uses `pushEvents`; hosts must choose the channel
path explicitly rather than relying on that default. Use `pushEvents` instead
for hosts that only support push/wake alerts. Do not enable both unless the host deliberately reconciles the copies.
Wake policies matching both scopes are compatibility matches, not deduplication.
Partial push/channel success retries only the failed path during the connection.
A crash before durable acknowledgement can replay an event; hosts should dedup
by `eventId`/`messageId`. This is at-least-once, not exactly-once delivery.

### Read output and pagination

Read tools return compact fields by default (ids, status, refs/SHAs, URLs,
actors, failure reasons and relevant text), not entire GitLab user objects.
`list_merge_requests`, `list_pipelines`, `list_discussions`, `list_tree`, and
`search_code` return `{items, page, limit, next_page, output_truncated}`.
The default is one page of 20 rows; set `page` and `limit` (1–100) to fetch more.
`next_page` is conservative: a full final page can point to an empty next page.
No tool pagination changes polling or write-preflight pagination.

`get_merge_request` defaults to metadata only, in `data`. Explicit
`include: "diff,discussions,approvals"` requests those extras. `page`/`limit`
apply to diffs and discussions; `diffs_page` reports diff continuation.
`get_pipeline` returns compact `pipeline.data` plus a paged `jobs` envelope.
`get_issue` also returns `{data, output_truncated}`.

Use `full: true` to include additional API fields. Both modes cap each string
at 4,000 UTF-8 bytes, nested arrays at 100 entries and depth at 10, with a
roughly 60 KB data budget per component (group searches share that budget
across projects). `output_truncated` flags size/depth clipping, not intentional
compact-field omission. Lower `limit` to recover rows clipped by a byte budget;
use `get_file` for source contents and `get_job_log` for bounded log tails.
This changes the earlier raw-array/raw-object read result shapes.

`search_code.group` means a GitLab **group**, not a user namespace. For a
user-owned repository use `project: "username/repository"`; a group 404 may
also mean the group is missing or inaccessible. Job logs strip ANSI controls
and GitLab section markers before literal grep; section heading text remains.

## Full environment reference

Lists are comma-separated. Unknown feature sets/tools and invalid values are
startup errors, aggregated where possible. Every `GITLAB_PROJECTS` entry must
resolve. Pipeline projects and branch watches must be inside that write/event
scope. Project selectors accept numeric ids or full nested paths; target-allow
entries use `branch` or **canonical** `group/project:branch` (exact, no glob).
Source/job globs support `*` (zero or more characters); other characters are literal.

| Variable | Default / behavior |
|---|---|
| `GITLAB_URL` | Required HTTPS origin/base path; `/api/v4` appended. No credentials, query or fragment. |
| `GITLAB_TOKEN_FILE` | Required regular mode-600 PAT file; whitespace-only/embedded-whitespace tokens refused. |
| `GITLAB_EXPECT_USERNAME` | Optional startup identity check. |
| `GITLAB_CA_FILE` | Optional PEM trust bundle for this connection, replacing default roots. Otherwise Node default trust applies (normally bundled Mozilla roots, NOT necessarily the host system store). For an internal CA on Debian/Ubuntu set `/etc/ssl/certs/ca-certificates.crt`; on other systems supply the appropriate PEM bundle. `NODE_EXTRA_CA_CERTS` can extend Node defaults at process startup when `GITLAB_CA_FILE` is unset. |
| `GITLAB_ALLOW_HTTP` | `false`; explicit lab-only HTTP exception. |
| `GITLAB_HTTP_TIMEOUT_MS` | `30000`, 1–300000; whole request including streamed trace. |
| `GITLAB_PROJECTS` | Required write/event allow-list, no globs/groups. Exactly `*` opts in to [all-projects mode](#all-projects-mode-gitlab_projects), which widens **events only**. |
| `GITLAB_PROJECTS_EXCLUDE` | Empty; only valid with `GITLAB_PROJECTS=*`. Exact path, numeric id, or `group/*` including subgroups. |
| `GITLAB_WRITE_ALLOW` | Empty; only valid with `GITLAB_PROJECTS=*`, where it is the **only** write authority and is required for every write feature set. Exact path, numeric id, or `group/*` including subgroups; a bare `*` is refused. |
| `GITLAB_READ_ALLOW` | Same as projects; exact path/id, `group/*` including subgroups, or `*`. **No default with `GITLAB_PROJECTS=*`**: it must be set explicitly. |
| `GITLAB_FEATURE_SETS` | `gitlab.events,gitlab.read`. |
| `GITLAB_TOOLS_DENY` | Empty; removes named tools, also from channel publication routes. |
| `GITLAB_MR_TARGET_ALLOW` | Empty: cannot create/retarget any MR. |
| `GITLAB_MR_SOURCE_PATTERN` | Empty: any branch not in target allow-list. Otherwise a `*` glob. |
| `GITLAB_MR_FORCE_DRAFT` | `false`; when true, create/title edits retain Draft and `draft=false` is refused. |
| `GITLAB_CI_RETRY_REFS` | Empty. Retained for compatibility, but CI retry tools currently fail closed regardless of this value (see README). |
| `GITLAB_MERGE_TARGET_ALLOW` | Empty; required when merge set declared. |
| `GITLAB_MERGE_AUTHOR_ONLY` | `true`. |
| `GITLAB_MERGE_REQUIRE_PIPELINE` | `true`, success for exactly the head SHA. |
| `GITLAB_MERGE_REMOVE_SOURCE_BRANCH` | `false`. |
| `GITLAB_DIFF_MAX_BYTES` | `200000` total diff text. |
| `GITLAB_DIFF_FILE_MAX_BYTES` | `40000` per file; cut files are listed. GitLab collapsed/too-large flags are also surfaced. |
| `GITLAB_JOB_LOG_MAX_BYTES` | `65536` tail bytes; per-call smaller max allowed. Literal grep, 0–20 context lines. |
| `GITLAB_FILE_MAX_BYTES` | `200000`; UTF-8 content with truncation flag. Binary files are not a fidelity-preserving download. |
| `GITLAB_SEARCH_FANOUT_MAX` | `10`, range 1–30. Group enumeration is read-filtered before any per-project search. |
| `GITLAB_EVENT_SOURCES` | `todos,own-mrs,pipelines`; also `reviewing,branches,threads`. |
| `GITLAB_BRANCH_WATCH` | Empty; `project:branch` entries, exact branch names. |
| `GITLAB_PIPELINE_EVENT_LOG_BYTES` | Default `0` (off); examples use `4096`. Max 65536 useful-text bytes per failed job, at most three jobs; ANSI controls and GitLab section markers are stripped before capping. Ordinary runner prose remains. |
| `GITLAB_HOT_POLL_INTERVAL_MS` | `20000`; minimum 10000, `0` disables hot polling. |
| `GITLAB_PIPELINE_PROJECTS` | Same as projects; must be a subset. With `GITLAB_PROJECTS=*`: empty, and required for `users`/`refs` scope. |
| `GITLAB_PIPELINE_SCOPE` | `own-mrs,own-merges`; also `users,refs`. |
| `GITLAB_PIPELINE_USERS` | Empty usernames of triggering users (e.g. project-token account). |
| `GITLAB_PIPELINE_REFS` | Empty exact refs (e.g. `main`). |
| `GITLAB_PIPELINE_STATUSES` | `failed,success`; allowed final statuses: success, failed, canceled, skipped. |
| `GITLAB_OWN_MERGE_WINDOW_MS` | `21600000` (6h); max 7 days. Merge/squash/head SHA remembered, including fast-forward. |
| `GITLAB_JOB_EVENT_PATTERN` | Empty; comma-separated `*` job-name globs. |
| `GITLAB_JOB_EVENT_STATUSES` | `failed`; same final-status vocabulary. |
| `GITLAB_POLL_INTERVAL_MS` | `60000`; 30000–3600000, never zero in this polling-only release. |
| `GITLAB_POLL_OVERLAP_MS` | `120000`; 1000–3600000. |
| `GITLAB_MAINTAINERS` | Empty usernames; optional maintainer tag only, not authority. |
| `GITLAB_SYSTEM_NOTES` | `drop`, or `keep`. |
| `GITLAB_STATE_FILE` | Unset = in memory; strongly recommended to set for restart continuity. |
| `GITLAB_LOG_LEVEL` | `info`; debug/info/warn/error, stderr only. |

`GITLAB_WEBHOOK_*`, `GITLAB_AGENT_USERS`, and `GITLAB_SHARED_ACCOUNT` are refused:
This connector supports polling only and numeric-user self identity, not bot or
shared-account heuristics. Prefer dedicated accounts.


The Bash launcher `deploy/gitlab-mcpl` additionally reads `GITLAB_MCPL_ENV_FILE`
(default `$HOME/.config/gitlab-mcpl/env`). It sources this operator-owned file;
use shell quoting there, not systemd EnvironmentFile syntax.

## Design notes

Polling cannot recover intermediate transitions that occur entirely between observations.
Own open merge requests are fully enumerated and hydrated each pass, increasing API traffic.
Hot polling is serialized and best-effort; slow I/O can exceed the configured interval.
Marker maps and rollback history grow with activity; monitor and protect the state file.

## Attribution

Code and tests are copied/adapted from **github-mcpl**, commit
`7958055c8ee051e79ddc3c7c38ef9f458bf8006e`, under the MIT license (see [LICENSE](LICENSE)).
This includes grant/error handling, state lineage, journaling, persistence and
state tests, plus the MCPL handshake, feature/ontology builders, per-channel
queue, event pipeline, comment/sticky/rollback algorithms and duplex fake-host
pattern adapted to GitLab contracts.
