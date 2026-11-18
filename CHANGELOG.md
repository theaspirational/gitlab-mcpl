# Changelog

## 0.1.0 — 2026-11-18

First release.

### Core features

- Polling-only GitLab connector with stdio and loopback TCP transports, MCP
  tools and negotiated MCPL feature sets, channels and push events.
- Scoped reads for merge requests, issues, discussions, pipelines, job logs,
  files, repository trees and Free-tier group code search.
- Explicit opt-in comments with checkpoint/rollback, MR creation/edit/reviewer
  requests, rebase and exact-SHA merge with layered authority checks.
- To-do, own/reviewer MR, pipeline/job and branch events; hot polling,
  persisted cursors, identity-bound state and per-delivery-path deduplication.
- PAT scope/identity validation, bounded reads, quick-action neutralization,
  route allow-listing, token-expiry notices and no automatic write retries.
- Operator/deployment examples, isolated live-test kit, MIT license and
  privacy-neutral examples. No live GitLab certification; CI retries fail
  closed on GitLab 17.11 and slow startup is fixture-tested only.

### All-projects scope and safety


- Opt-in all-projects mode: `GITLAB_PROJECTS=*` with `GITLAB_PROJECTS_EXCLUDE`
  (exact path, numeric id, `group/*`). To-dos are taken from every visible
  project; own MRs and own merges come from instance-level
  `GET /merge_requests?scope=created_by_me`; pipelines are read only in
  projects with an open or recently merged own MR, plus explicit
  `GITLAB_PIPELINE_PROJECTS`. Excludes are decided on the server-returned id
  and canonical path, including for rows that only reveal a project id.
- `*` widens events only. Write authority in that mode comes solely from the
  new `GITLAB_WRITE_ALLOW` (exact path, numeric id, `group/*`; a bare `*` is
  refused), checked on the canonical id/path for every tool write, channel
  publication and rollback; an exclude wins over an allow. A project that is
  only in event scope can deliver events and have a channel but is never
  written.
- With `*`, startup refuses: any write feature set without `GITLAB_WRITE_ALLOW`,
  an unset `GITLAB_READ_ALLOW` (when `gitlab.read`
  is declared), the `reviewing` and `threads` sources, `users`/`refs` pipeline
  scope without `GITLAB_PIPELINE_PROJECTS`, and bare-branch entries in
  `GITLAB_MR_TARGET_ALLOW` / `GITLAB_MERGE_TARGET_ALLOW`.
- In that mode the token-expiry notice uses the channel `gitlab:*@pipelines`.

### Fixed

- `channels/open` history is a read and now requires `GITLAB_READ_ALLOW`. It
  was checked against event scope only, so with `GITLAB_PROJECTS=*` a host
  could fetch note bodies of any visible project. Refused before the channel
  is registered or a note is fetched; opening without history (or limit 0)
  remains an event-scope operation. Also applies in list mode when the read
  allow is narrower than the project list.

- Persisted poll state no longer bypasses the current configuration. Hot
  pipeline watches are revalidated at load, before every poll pass and before
  every hot poll against the current event sources and event scope, in list
  mode and in all-projects mode, and dropped before any GitLab read if they
  fail (previously a reviewer watch saved under `EVENT_SOURCES=reviewing` was
  still polled and delivered after a restart under `GITLAB_PROJECTS=*`,
  `EVENT_SOURCES=todos`). Own-MR/own-merge interest sets and poll cursors of a
  disabled source or out-of-scope project are dropped the same way.

### Unchanged

- With a project list in `GITLAB_PROJECTS`, configuration defaults, queries,
  scope decisions and events are as before. `GITLAB_PROJECTS_EXCLUDE` without
  `*` is a startup error, and so is `GITLAB_WRITE_ALLOW`: with a list,
  `GITLAB_PROJECTS` remains the write list.

All-projects mode is covered by fixture tests only; it has not yet been run
against a live GitLab instance.
