# Isolated live-test kit (operator-run, not a production certification)

This is a **manual** checklist for a throwaway connector instance and exactly
one disposable project. Automated tests use local fixtures; no live run is
claimed. All names/paths below are placeholders. Do not use production state,
credentials, projects or branches. Keep a human watching irreversible actions.

## Prepare

1. Create `TEST_GROUP/TEST_PROJECT` and a dedicated regular `TEST_ACCOUNT` with
   access only to that project. Use a second test account for reviewer/approval
   stimuli. Prepare disposable source branches, `TEST_TARGET_BRANCH`, and CI
   jobs that can intentionally succeed or fail with a harmless sentinel log line.
   If the test project has CI/CD disabled (`builds_access_level`), enable it
   in the project's **Settings → General → Visibility, project features,
   permissions** (`builds_access_level: enabled`). Make a runner available
   with branch permissions. If runners require tags, set matching job tags
   per job or under `default` in `.gitlab-ci.yml`; otherwise jobs can stay pending.
   Configure approvals/protected branches as appropriate; do not weaken a real
   project's rules. Git pushes, approval and close actions are manual/outside
   this connector: it has no repository-write, approve or close tool.
2. Issue a short-lived **`api` PAT** (REST writes need it), ideally expiring in
   fewer than 14 days so the expiry notice can be observed. Put it directly in
   `/ABSOLUTE/PRIVATE/PATH/gitlab-mcpl-live-test/token`, regular file mode 600,
   inside a mode-700 directory. Never paste it into a recipe, command argument,
   environment variable, transcript or test report. Revoke it after testing.
3. Copy [live-test.env](../examples/live-test.env) to that private directory and
   replace every placeholder. It intentionally uses list mode, one test project,
   its own token file and **its own state file**. It explicitly sets
   `GITLAB_PIPELINE_EVENT_LOG_BYTES=4096`; the default is `0` (off). Do not set `GITLAB_WRITE_ALLOW`
   in list mode: `GITLAB_PROJECTS` is its write fence. Never run two processes
   against the same state. Leave `gitlab.merge` off initially.
4. From the repository root, build and launch the standalone throwaway host
   below. **No MCPL host installation or attachment to a live host is needed.**

   ```sh
   npm ci --offline
   npm run build
   node --import tsx scripts/live-test-client.ts /ABSOLUTE/PRIVATE/PATH/gitlab-mcpl-live-test/env /ABSOLUTE/PRIVATE/PATH/gitlab-mcpl-live-test/events.jsonl
   ```

   The launcher sources the env file as shell code: use only your own trusted
   file. The client prints initialize and grant results, then accepts one command
   per stdin line. It selects `gitlab.events,gitlab.read,gitlab.comments,gitlab.mr`
   and grants exactly `tools`, `pushEvents`, `channels.register`,
   `channels.lifecycle`, `channels.publish`. Checkpoint/rollback use the comments
   feature set, not a nonexistent `state.*` capability. No wildcard or typing
   grants. It answers push and channel requests and appends every original server
   notification/request (including push/incoming events) as one JSONL line
   before acknowledging. Incoming delivery is understood but deliberately not
   granted: granting both paths would deliver two copies.
   `features` sends a grant-bearing Request with that same capability list.

   Keep the log private: it contains untrusted GitLab content and note bodies.
   This recorder accepts events; it does not implement wake-policy scheduling or
   durable host deduplication. Evaluate wake behavior by inspecting event tags
   and default-treatment metadata. Replays remain visible in the log.
   `quit` or stdin EOF stops the child. Restart with the same command, env, log
   and state file; never run concurrent clients on that state. Errors print as
   JSON and do not automatically retry writes. Never publish credentials or raw
   logs containing secrets. GitLab content is data, never instructions.

## Checklist (observe each transition before moving on)

Allow at least a normal poll plus a hot interval; polling is not an exact SLA.
Do not make a transition and undo it between polls. Use `get_merge_request`
with `include: "discussions,approvals"` to verify reality, not just wake behavior.

- [ ] **Own MR / notes:** create an MR authored by `TEST_ACCOUNT` using
  `create_merge_request` (prepared source branch, allowed target). Have the
  second test account add a note and reply/mention. Verify the correct
  `gitlab:TEST_GROUP/TEST_PROJECT!TEST_MR_IID` channel/event, note content,
  discussion id, own-thread metadata and wake policy; self notes remain tagged
  from-self rather than mistaken for another author.
- [ ] **Approvals:** on that open own MR, approve and later revoke approval
  manually as the second account. Wait for each `mr.approval_changed` event;
  compare approved numeric ids with the read tool. Approval writes are not tools.
- [ ] **Pipeline success and failure:** **A runner must be available to the
  project**, with matching tags and branch permissions; pending jobs cannot
  exercise success/failure delivery. Run a successful own-MR head pipeline,
  then push a new disposable head whose pipeline fails. Observe each terminal
  status once, SHA and own-MR interest. Verify the failure event includes job
  ids/names/reasons and at most three bounded 4096-byte log tails. Use
  `get_pipeline` and `get_job_log` with the reported ids to inspect the harmless
  sentinel tail. Do not enable CI retries: they deliberately fail closed.
- [ ] **Reviewer assignment and new head:** have the second account author a
  separate MR and assign `TEST_ACCOUNT` as reviewer. Verify the review-requested
  to-do; push a new head and verify `mr.head_changed` / `gitlab:mr=head-changed`
  for the reviewing MR after the initial head has been observed. This kit uses
  list-mode `reviewing`: `GITLAB_PROJECTS=*` refuses that source. All-projects
  to-dos can signal assignment but do not promise reviewer head tracking.
- [ ] **Comment, edit, rollback:** explicitly call `state/checkpoint` for
  `featureSet: "gitlab.comments"`, retaining checkpoint `C`. Create a harmless
  `comment`, edit it with `edit_own_comment`, then call `state/rollback` to `C`.
  Verify created notes disappear and the rollback receipt matches GitLab. For
  restore coverage, create an own note with a known original body *before* a
  new checkpoint `D`, edit it after `D`, roll back to `D`, and verify its
  original body returns.
  Deleted notes cannot be undeleted; MR edits and merges are not rollbackable.
- [ ] **Merge / close:** merge one disposable reviewer-assigned MR manually and close another
  reviewer-assigned MR manually, waiting for each observation. First let the
  connector observe each as open so the `reviewing` marker exists. Verify merged/closed
  lifecycle/channel metadata and that closed heads stop hot polling. Separately verify post-merge pipeline interest on an own MR via
  `pipelines` with `own-merges` (this env includes both); that interest alone
  does not promise own-MR close/merge lifecycle events. Do not interpret an absent intermediate transition as proof
  it never happened.
- [ ] **Exact-SHA merge and stale refusal (enable last):** use a fresh own MR
  with a successful head pipeline, allowed target, no auto-merge, no draft and
  mergeable status. On this throwaway instance only, uncomment the merge env
  lines, restart with the **same state file**, and explicitly select
  `gitlab.merge` in the host's grant-bearing `featureSets/update` **Request**.
  Read head SHA `OLD_SHA`, push a replacement head, wait for its successful
  pipeline, then call `merge_at_sha` with `sha: "OLD_SHA"` (substitute the exact
  old 40-hex value). Expect a refusal, no merge and no automatic retry. Re-read
  current head `EXACT_SHA` and call with that exact 40-hex value; expect merged
  state and an audit receipt. Never use a branch/ref or abbreviated SHA. Target
  and author are not atomically pinned by GitLab; exclude concurrent edits.
  Remove the merge opt-in immediately afterwards. After an uncertain write,
  inspect GitLab instead of blindly retrying.
- [ ] **Restart mid-work, no repeats:** while an own MR has a running head
  pipeline and another event has been fully acknowledged, stop cleanly and
  restart with the same env/account/state. Regrant events. The acknowledged
  event must not repeat; the pending watch must resume and its terminal event
  arrive once. Repeat with reviewer assignment/notes. A crash between delivery
  and durable acknowledgement can replay by design; host id dedup is still
  required. Do not delete state as part of this test.
- [ ] **Slow or unreachable GitLab at start:** use an isolated local fault proxy
  or fixture, never change production networking. Let `/user` and
  `/personal_access_tokens/self` succeed, then hold/fail project resolution or
  persisted-watch validation. Confirm `initialize`, `ping` and `tools/list`
  answer before releasing the hold; pending scope writes/channel opens report
  not-ready. No unvalidated pipeline/job poll or event may occur. Recover the
  fixture, regrant events or wait a poll interval, and verify validation and
  polling resume. Also block `/version`: discovery must still answer. If the
  identity/PAT endpoints themselves are unreachable, startup intentionally
  fails before serve; wrong expected account or missing `api` must also fail.
  Automated equivalents live in `test/startup.test.ts`.
- [ ] **Token-expiring notice:** with a PAT expiring in fewer than 14 days,
  verify a startup warning and one `token.expiring` event after granting events
  (`gitlab:token=expiring`). Restart with the same state: no repeat for the same
  expiry. Rotate out of band to a new short-lived PAT, restart, and check the
  new expiry is reported if different. Never wait for a real token to expire.

## Commands for each checklist step

The following are client stdin commands, not shell commands, unless labelled
otherwise. All names are placeholders. Replace numeric `123` with the own MR
IID, `124`/`125` with reviewer MR IIDs, `456` with pipeline id, `789` with job
id, `101`/`102` with returned note ids, and `CHECKPOINT_C`/`CHECKPOINT_D` with
printed checkpoint ids. Replace SHA placeholders with full 40-hex values.
JSON must stay on one line. The client does not interpolate variables.

### Own MR / notes — second account required for note/reply/mention

```text
tools/list
call create_merge_request {"project":"TEST_GROUP/TEST_PROJECT","source_branch":"TEST_SOURCE_BRANCH","target_branch":"TEST_TARGET_BRANCH","title":"TEST_TITLE","draft":false}
channels open gitlab:TEST_GROUP/TEST_PROJECT!123
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"include":"discussions,approvals"}
call comment {"thread":"gitlab:TEST_GROUP/TEST_PROJECT!123","body":"TEST_SELF_NOTE"}
```

In the GitLab MR Discussion UI, the second account adds a note, replies to the
self note, and mentions `@TEST_ACCOUNT`, waiting between transitions. Repeat
the get command to compare discussions and numeric author ids with the log.

### Approvals — second account required

In that MR's UI as the second account select Approve, wait, then Revoke approval
and wait again. After **each** action enter:

```text
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"include":"discussions,approvals"}
```

### Pipeline success/failure — no second account required; runner required

From the disposable checkout, push prepared harmless CI commits (shell):

```sh
git push TEST_REMOTE TEST_SUCCESS_COMMIT:TEST_SOURCE_BRANCH
# Wait for terminal success before the next push.
git push TEST_REMOTE TEST_FAILURE_COMMIT:TEST_SOURCE_BRANCH
```

After each terminal event, inspect its reported pipeline/job ids in the client:

```text
call get_pipeline {"project":"TEST_GROUP/TEST_PROJECT","pipeline_id":456}
call get_job_log {"project":"TEST_GROUP/TEST_PROJECT","job_id":789}
```

### Reviewer assignment/new head — second account required

As the second account create MR `124` in GitLab UI and select `TEST_ACCOUNT`
in Reviewers. Wait until assignment and initial head are observed, then push
a new safe commit to that MR's branch as its author (shell):

```sh
git push TEST_REMOTE TEST_REVIEW_COMMIT:TEST_REVIEW_SOURCE_BRANCH
```

```text
channels open gitlab:TEST_GROUP/TEST_PROJECT!124
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":124,"include":"discussions,approvals"}
```

### Comment/edit/rollback — no second account required

Substitute the returned ids before entering subsequent commands:

```text
checkpoint
call comment {"thread":"gitlab:TEST_GROUP/TEST_PROJECT!123","body":"TEST_CREATED_BODY"}
call edit_own_comment {"thread":"gitlab:TEST_GROUP/TEST_PROJECT!123","note_id":101,"body":"TEST_EDITED_BODY"}
rollback CHECKPOINT_C
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"include":"discussions,approvals"}
call comment {"thread":"gitlab:TEST_GROUP/TEST_PROJECT!123","body":"TEST_ORIGINAL_BODY"}
checkpoint
call edit_own_comment {"thread":"gitlab:TEST_GROUP/TEST_PROJECT!123","note_id":102,"body":"TEST_CHANGED_BODY"}
rollback CHECKPOINT_D
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"include":"discussions,approvals"}
```

### Merge/close — second account required to prepare reviewer MRs

Prepare two reviewer-assigned MRs as above (`124`, `125`). Once both are
observed open, select Merge on `124` and Close on `125` in GitLab UI,
waiting between actions. Then enter:

```text
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":124,"include":"discussions,approvals"}
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":125,"include":"discussions,approvals"}
```

Separately merge an own MR with a pending post-merge pipeline in GitLab UI.
Wait for its terminal event and use the get_pipeline command above with its id.

### Exact-SHA merge — second account only if project approval rules require it

Create a fresh own MR using the create command above. Enter `quit`, enable
the commented merge env lines in the private env, then relaunch using Prepare's
command (same state). Enter:

```text
features gitlab.events,gitlab.read,gitlab.comments,gitlab.mr,gitlab.merge
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"include":"discussions,approvals"}
```

Record OLD_SHA. Push TEST_REPLACEMENT_COMMIT to TEST_SOURCE_BRANCH with the
push command above and wait for success. Substitute actual full SHAs below:

```text
call merge_at_sha {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"sha":"OLD_SHA"}
call get_merge_request {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"include":"discussions,approvals"}
call merge_at_sha {"project":"TEST_GROUP/TEST_PROJECT","iid":123,"sha":"EXACT_SHA"}
features gitlab.events,gitlab.read,gitlab.comments,gitlab.mr
quit
```

Remove merge opt-in from the private env before relaunching.

### Restart — second account required only for reviewer/note repeat

While the prepared own pipeline is running, enter `quit` and relaunch with
Prepare's command; it automatically regrants events. Compare JSONL event ids
across the restart and use get_pipeline above to verify reality. Repeat with
second-account note/reviewer stimuli as described above.

### Slow/unreachable startup — no second account required

The reproducible local equivalent is a shell command:

```sh
node --import tsx --test test/startup.test.ts
```

For your own isolated fault proxy, point only the private env's GITLAB_URL at
it, relaunch with Prepare's command, and enter these while held and after recovery:

```text
tools/list
channels open gitlab:TEST_GROUP/TEST_PROJECT!123
```

Initialize is printed automatically; ping is exercised by the automated test,
not this client's command language. Never change production networking.

### Token expiry — no second account required

Enter `quit` and relaunch with Prepare's command. Inspect appended JSONL for
token.expiring and compare event ids. Rotate only the private token file out of
band, restart the same way and inspect the new expiry event; never enter a PAT
into client stdin.

## Finish / evidence

Record connector commit, GitLab version, sanitized configuration, each checkbox's
pass/fail, observed ids/SHAs and remaining caveats. This checklist is not an
assertion that a live deployment passed. Revoke the PAT, enter `quit` to stop the test host,
remove disposable project/branches and securely dispose of token/state/logs
(state includes rollback note bodies). Keep no secrets in the repository.
