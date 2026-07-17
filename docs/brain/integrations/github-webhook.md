# integrations/github-webhook

The **inbound GitHub webhook** that fires the two **PR mirror gates** ([[../libraries/github-pr-resolve]]). GitHub POSTs to `POST /api/webhooks/github` on the events that can change an open build PR's state; the handler runs:
1. **Dirty-PR Resolver** ([[../specs/dirty-pr-resolver-agent]]) — detect newly-`CONFLICTING` `claude/*` PRs → enqueue a [[../tables/agent_jobs]] `kind='pr-resolve'` job each.
2. **Auto-merge gate** ([[../specs/auto-ship-pipeline]] Phase 1 / Gate A) — squash-merge + delete branch ONE READY (mergeable + all-checks-green) `claude/*` PR. (A one-off promote-eligible spec's whole-spec branch ships here; all its phases stamp shipped — spec-goal-branch-pm-flow M5 Part 3.)
3. **Gate B — spec→goal-branch integration** ([[../specs/spec-goal-branch-pm-flow]] M4, [[../libraries/agent-jobs]] `promoteEligibleSpecsToGoalBranch`) — merge every goal-bound promote-eligible spec branch onto its `goal/{slug}` branch (does NOT touch main).
4. **Gate C — atomic goal→main promotion** ([[../specs/spec-goal-branch-pm-flow]] M5, [[../libraries/agent-jobs]] `promoteCompleteGoalsToMain`) — for every COMPLETE + GREEN goal branch, merge `goal/{slug}` → main in ONE merge and flip every member phase shipped (the only shipped-writer), then trigger the fold pipeline. **Parent goals are SKIPPED** (their children promote independently). Each gate is independent; a failure in one never blocks the others; all run identically in the box worker standing pass.
5. **⚡ Gate D — event-driven pre-merge trigger** (preview-ready-event-trigger, [[../libraries/agent-jobs]] `enqueuePreMergeFromDeploymentReady`) — on a `deployment_status` with `state='success'` for a PREVIEW deploy, map the deploy's commit SHA → its `claude/build-*` branch (`resolveBuildBranchForSha`), persist the preview URL on the build job, and fire the fused Vera/Vault pre-merge session THE MOMENT the preview goes READY. This replaces the retired in-worker 6-min `pollCapturePreviewUrl` loop — the session now starts within seconds instead of waiting for the box's next standing pass. `backstopPreMergeChecks` stays as the safety net for a dropped delivery. A `deployment_status` event runs ONLY Gate D (it carries none of the PR-gate signals), so the four PR gates no-op for it.

**Event-driven, not a cron** — it fires the moment a merge to `main` dirties something or a PR's checks go green.

## Endpoint (HMAC-verified)

| Route | Handles |
|---|---|
| `POST /api/webhooks/github` | `push` (to `main`), `pull_request` (opened·synchronize·reopened·ready_for_review), `check_suite`/`check_run` (completed), `status` (success), `deployment_status` (success → Gate D preview-ready trigger), `ping` |

Verification runs **first** on the raw body: `verifyGithubWebhook(rawBody, X-Hub-Signature-256, GITHUB_WEBHOOK_SECRET)` ([[../libraries/github-pr-resolve]]) — HMAC-SHA256(`GITHUB_WEBHOOK_SECRET`, raw bytes), constant-time compared against the `sha256=<hex>` header. A missing/invalid signature → `401`. Without it anyone who learns the URL could spoof a build-queue enqueue. A `ping` (sent when the hook is first configured) is acked `{ok,pong}`.

## Flow

1. Verify signature → parse → read `X-GitHub-Event`.
2. **Relevance filter** — `dirtyRelevant` = a `push` to `refs/heads/main` or a `pull_request` open/synchronize/reopen/ready; `mergeRelevant` = those PLUS `check_suite`/`check_run` completed or `status` success (the events that flip a PR to READY). Neither → acked `{ok, skipped}` with no work.
3. **ACK GitHub immediately** with `{ok, deferred: true}`. The four gates below run in `after()` on the same Lambda invocation, wall-clock-bounded to 250s (see **ACK-fast + bounded after()** below).
4. `detectAndEnqueueDirtyPrs()` (when `dirtyRelevant`) — list open `claude/*` PRs → check each `mergeable` (polled) → enqueue ONE deduped `pr-resolve` job per newly-`CONFLICTING` PR.
5. `autoMergeReadyPrs()` (when `mergeRelevant`, in its own try so it can't block the dirty gate) — squash-merge + delete branch ONE READY `claude/*` PR (serialized, sync-aware, kill-switched). See [[../libraries/github-pr-resolve]].
6. Gate B — `promoteEligibleSpecsToGoalBranch()` ([[../libraries/agent-jobs]], [[../specs/spec-goal-branch-pm-flow]] M4) — merge every promote-eligible spec branch onto its `goal/{slug}` branch.
7. Gate C — `promoteCompleteGoalsToMain()` ([[../libraries/agent-jobs]], [[../specs/spec-goal-branch-pm-flow]] M5) — atomic goal→main merge + shipped-stamp for every COMPLETE + GREEN goal branch.

The box worker's `pr-resolve` lane (`runPrResolveJob`, [[../recipes/build-box-setup]]) then claims each resolve job and does the merge + resolve + tsc-gate + push (or rebuild-on-main / surface-to-owner). The auto-merge gate, by contrast, performs the merge inline in the webhook (one REST call) — no worker.

### ACK-fast + bounded `after()`

Each of the four gates lists every open `claude/*` PR and makes per-candidate GitHub REST calls (fetch mergeable, per-member spec-eligibility, `/merges`). On a busy build board the combined work exceeded Vercel's 300s Lambda cap in the response path, killing the delivery mid-fanout and re-feeding the Runtime Timeout as a `level=error` log back through the Vercel log drain (self-feeding via [[vercel-log-drain]]). The handler now:

- ACKs GitHub with `{ok, deferred: true}` the moment the event passes HMAC + ping + relevance (GitHub only needs the ACK — it redelivers on failure).
- Runs the four gates inside `after(async () => { ... })` from `next/server`. `after()` runs on the SAME Lambda invocation, so it still counts against the 300s cap.
- Wall-clock-bounds the callback to **250_000 ms** (50s under the cap): before each gate, if `Date.now() - started > 250_000`, warn with `[github-webhook] after() deadline hit, deferring %d gate(s)` and return. Any deferred gate is a no-op for this invocation; the next GitHub event OR the box worker's platform-director standing pass (which re-runs these exact gates) picks it up. Each gate keeps its own try/catch so a failure in one still lets the others run.

Same shape as the [[vercel-log-drain]] webhook (PR #1472) — both webhooks share one bounded-fanout pattern and one place to reason about the Vercel cap.

## Setup

Configure a repository webhook on `thecyclecoder/shopcx` → payload URL `https://shopcx.ai/api/webhooks/github`, content type `application/json`, secret = the `GITHUB_WEBHOOK_SECRET` env value, events: **Pushes** + **Pull requests** (dirty-PR resolver) PLUS **Check suites** + **Check runs** + **Statuses** (so auto-merge fires the moment a PR's checks go green) PLUS **Deployment statuses** (Gate D — so the fused Vera/Vault pre-merge session fires the moment a preview goes READY). The handler calls back into the GitHub REST API with `GITHUB_TOKEN` / `AGENT_TODO_GITHUB_TOKEN` (the same token the build console uses to list/close/merge PRs + resolve a deploy SHA → its build branch). The event subscription is set via `gh api -X PATCH repos/thecyclecoder/shopcx/hooks/{id} -f 'events[]=…'`.

## Gotchas

- **`mergeable` is lazy.** Right after a push it's `null` (still computing); the detector polls the single-PR GET a few times before deciding. A still-`null` result is skipped — a later event re-checks it. See [[../libraries/github-pr-resolve]].
- **`claude/*` only.** A non-`claude/*` PR (a human PR) or a clean PR triggers nothing — the relevance filter + the `claude/*` head-ref filter + the `mergeable === false` gate all have to pass.
- **Repo-level, one workspace.** No per-workspace secret/lookup (unlike the [[shopify|Shopify]] / Appstle webhooks) — one repo serves one build console, so the job attaches to the build-console workspace.
- **Idempotent.** `push` + `synchronize` can both fire for the same change; `enqueuePrResolveJob` dedupes one active job per PR. Auto-merge is naturally idempotent (a merged PR is no longer open/clean) and serialized (one merge per pass).
- **Auto-merge kill-switch + sync-aware.** Gate A no-ops while `workspaces.auto_merge_enabled === false` or an Inngest [[../tables/sync_jobs|sync]] is active (a deploy would reap it). Registered in the [[../libraries/control-tower]] as the `auto-merge-gate` reactive loop — every pass beats, every merged PR # is in `produced` + the log.
- **Security pass on every merge.** A merged `claude/*` build runs [[../libraries/agent-jobs]] `applyMergedBuildEffects`, which fires the per-diff security pass ([[../libraries/security-agent]] `enqueueSecurityReviewJob`, deduped by merge SHA) — the supervisor on the auto-merge proxy ([[../specs/security-dependency-agent]] Phase 1).
- **300s Vercel cap → `after()` + 250s deadline.** The response path only does HMAC + JSON + relevance + ACK; the four gates run inside `after()` on the same invocation, wall-clock-bounded to 250s. A deferred gate is picked up by the next event or the box worker's standing pass — see **ACK-fast + bounded `after()`** above.
