# Environment reference

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

## All-projects mode (`GITLAB_PROJECTS=*`)

Opt-in. With a project list, nothing below applies and behaviour is unchanged.
`*` must be the only entry; globs and group prefixes in `GITLAB_PROJECTS` stay
refused. The **event** scope becomes **every project the token can resolve,
minus `GITLAB_PROJECTS_EXCLUDE`**. Projects are not enumerated at startup; only
explicitly named ones (`GITLAB_PIPELINE_PROJECTS`, `GITLAB_BRANCH_WATCH`) and
projects named by retained poll state are resolved and checked then.

`*` widens events only. Reads stay governed by `GITLAB_READ_ALLOW`, and writes
by `GITLAB_WRITE_ALLOW`; `*` implies neither. A project can therefore deliver
events and have a channel while every tool write, `channels/publish` and
rollback against it is refused with `not in GITLAB_WRITE_ALLOW`.

The same holds for reads on request. `channels/open` creates a channel for any
project in event scope, but its optional `history` (limit above 0) returns note
bodies without an incoming event, so it needs `GITLAB_READ_ALLOW` like a read
tool and is otherwise refused with `not in GITLAB_READ_ALLOW` before the channel
is registered or a note is fetched. Open without history (or with limit 0) to
get the channel only. With `gitlab.read` undeclared and `GITLAB_READ_ALLOW`
unset the read allow is empty, so no history is served. This also applies in
list mode when `GITLAB_READ_ALLOW` is set narrower than `GITLAB_PROJECTS`; the
list-mode default (read allow = project list) is unchanged.

Which authority each path needs before it reads GitLab:

| Path | Authority |
|---|---|
| Read tools (`gitlab.read`), `channels/open` history | read: `GITLAB_READ_ALLOW` |
| Comment/MR/CI/rebase/merge tools, `channels/publish`, `state/rollback`, including their pre-flight lookups and the MR source project for edit/rebase | write: `GITLAB_WRITE_ALLOW` (list mode: `GITLAB_PROJECTS`) and not excluded |
| Poll and hot-poll sources, event delivery, channel creation (`channels/open` without history, tool touch) | event: `GITLAB_PROJECTS` / `*` minus excludes |

Event content (note bodies, pipeline results, optional log tails) is delivered
for every project in event scope; that is what `*` opts into. A write tool's
answer describes the object it wrote or refused to write (for example the MR
returned by an edit, or the head SHA and failed jobs in a merge refusal) under
write authority alone. Deciding any scope resolves the project once with
`GET /projects/:id`, so a refusal names its canonical path.

Nothing that used to default to the project list widens silently:

| Setting | Rule with `*` |
|---|---|
| `GITLAB_READ_ALLOW` | Startup refuses when it is unset and `gitlab.read` is declared. Write `*` to read everywhere, a narrower list, or empty for no reads. Excludes do **not** restrict reads; only this list does. |
| `GITLAB_PIPELINE_PROJECTS` | Defaults to empty. `users`/`refs` pipeline scope is refused without it. |
| `GITLAB_MR_TARGET_ALLOW`, `GITLAB_MERGE_TARGET_ALLOW` | Every entry must be `project:branch`; a bare branch would apply to every project and is refused. |
| `GITLAB_EVENT_SOURCES` | `reviewing` and `threads` are refused: they are per-project reads with no bounded instance-wide form. `branches` remains available because `GITLAB_BRANCH_WATCH` is an explicit list. |
| `GITLAB_WRITE_ALLOW` | Startup refuses any write feature set (`gitlab.comments`, `gitlab.mr`, `gitlab.ci`, `gitlab.rebase`, `gitlab.merge`) when it is unset or empty. Writes are allowed only in projects matching it (exact path, numeric id, `group/*`; never a bare `*`) that are not excluded; an exclude wins over an allow. Matching uses the server-returned id and canonical path. Rebase additionally requires the MR's source project to match. |

Where events come from (GitLab 17.11 Free REST):

- **To-dos and mentions:** `GET /todos`, pending and done, with no project filter (the same query as list mode; only the scope decision differs).
- **Own MRs:** one `GET /merge_requests?scope=created_by_me&state=opened` per pass instead of one list per project; notes, approvals and hot head-pipeline watches then work per MR as before. Rows are still checked against the numeric author id.
- **Own merges:** one `GET /merge_requests?scope=created_by_me&state=merged&updated_after=…` per pass.
- **Pipelines:** GitLab has no instance-level pipeline list. `GET /projects/:id/pipelines` is read only for projects where that pass found an open own MR or an own merge inside `GITLAB_OWN_MERGE_WINDOW_MS`, and only `own-mrs`/`own-merges` interest counts there. A project's first pipeline read starts one poll interval (plus overlap) back; when a project leaves that set its cursor is dropped. Explicit `GITLAB_PIPELINE_PROJECTS` entries are always read, with every configured scope.

Excludes and rows that only carry a project id: before any event, per-MR read
or channel, the id is resolved with `GET /projects/:id` and the rule is matched
against the **server-returned id and canonical path**, never a path spelled in
the row. Results are cached for the process lifetime. A project that answers
403/404 produces no event; any other failure fails that source and retains its
cursor. The server re-checks event scope on every delivery and `channels/open`,
and write scope on every write, so an excluded project never gets a channel. A project renamed or transferred
into or out of an excluded prefix is re-evaluated at restart; use a numeric id
rule where that matters.

Persisted state is held to the same rules. A hot pipeline watch, own-MR or
own-merge entry, or poll cursor written under an earlier configuration (for
example reviewer watches from list mode with `reviewing`) is checked against
the current sources and event scope at load and before every hot poll, and
dropped before any GitLab read if it fails. A path or `group/*` exclude is
decided without touching the project; an id exclude costs one
`GET /projects/:path` and nothing below it. This applies in list mode too.

Channels for projects found at runtime follow the normal lifecycle: registered
lazily on the first event, tool touch or `channels/open`, and not retracted
during the connection. With no first project to anchor it, the token-expiry
notice is delivered on the inbound-only channel `gitlab:*@pipelines`.

## Bounds and expected load

Offset pages contain 100 rows, at most 100 pages. Overflow **fails the operation**
(and preserves the poll source cursor), rather than falsely claiming a complete
read. Sorted note/done-to-do reads stop when they pass the overlap window.
JSON HTTP responses are limited to 8 MB; oversized responses fail safely.
Traces stream through a bounded tail buffer. Tool rendering caps individual
strings at 200 KB and total data at 1 MB; event rendering caps total data at 32 KB.
Tree results display at most 1,000 entries. Large discussions can hit pagination
bounds and need a narrower watch scope; no silent cursor advancement occurs.

Poll loops are serialized, including hot polls. Intervals are scheduled after
completion, so API/host delays add to nominal latency; they are not a 20-second
SLA. Own open MRs are fully listed and hydrated per pass, approvals are read
per own MR, and changed notes fetch discussion context. Full hydration avoids
stale interest and head sets but requires additional API reads rather than only
fetching incremental changes.
Reviewer lists use overlap windows plus an unfiltered open-list safety net every
10 passes. Group search can cost up to the fan-out cap per call: account for the
instance's search limit. Jobs/logs are also subject to instance rate limits.
No external rate-limit assumptions disable 429 handling.

### Own-head pipelines around a merge

Both list and all-projects modes rebuild own-MR interest from `state=opened`.
A head SHA found there is `own-mr` with its IID. If the MR has already merged
before that list, the SHA can instead match the bounded own-merge set (which
includes head, merge and squash SHAs): `own-merge`, on the pipelines channel,
without a thread IID. A merge between the open-list read and its detail read
can still yield `own-mr` for that pass. This is a polling ordering effect, not
an all-projects association gap; comparing instances requires the same timing.
