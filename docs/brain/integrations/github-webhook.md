# integrations/github-webhook

The **inbound GitHub webhook** that fires the two **PR mirror gates** ([[../libraries/github-pr-resolve]]). GitHub POSTs to `POST /api/webhooks/github` on the events that can change an open build PR's state; the handler runs:
1. **Dirty-PR Resolver** ([[../specs/dirty-pr-resolver-agent]]) — detect newly-`CONFLICTING` `claude/*` PRs → enqueue a [[../tables/agent_jobs]] `kind='pr-resolve'` job each.
2. **Auto-merge gate** ([[../specs/auto-ship-pipeline]] Phase 1 / Gate A) — squash-merge + delete branch ONE READY (mergeable + all-checks-green) `claude/*` PR.

**Event-driven, not a cron** — it fires the moment a merge to `main` dirties something or a PR's checks go green.

## Endpoint (HMAC-verified)

| Route | Handles |
|---|---|
| `POST /api/webhooks/github` | `push` (to `main`), `pull_request` (opened·synchronize·reopened·ready_for_review), `check_suite`/`check_run` (completed), `status` (success), `ping` |

Verification runs **first** on the raw body: `verifyGithubWebhook(rawBody, X-Hub-Signature-256, GITHUB_WEBHOOK_SECRET)` ([[../libraries/github-pr-resolve]]) — HMAC-SHA256(`GITHUB_WEBHOOK_SECRET`, raw bytes), constant-time compared against the `sha256=<hex>` header. A missing/invalid signature → `401`. Without it anyone who learns the URL could spoof a build-queue enqueue. A `ping` (sent when the hook is first configured) is acked `{ok,pong}`.

## Flow

1. Verify signature → parse → read `X-GitHub-Event`.
2. **Relevance filter** — `dirtyRelevant` = a `push` to `refs/heads/main` or a `pull_request` open/synchronize/reopen/ready; `mergeRelevant` = those PLUS `check_suite`/`check_run` completed or `status` success (the events that flip a PR to READY). Neither → acked `{ok, skipped}` with no work.
3. `detectAndEnqueueDirtyPrs()` (when `dirtyRelevant`) — list open `claude/*` PRs → check each `mergeable` (polled) → enqueue ONE deduped `pr-resolve` job per newly-`CONFLICTING` PR.
4. `autoMergeReadyPrs()` (when `mergeRelevant`, in its own try so it can't block the dirty gate) — squash-merge + delete branch ONE READY `claude/*` PR (serialized, sync-aware, kill-switched). See [[../libraries/github-pr-resolve]].
5. Respond `{ok, checked, conflicting, enqueued, prs[], autoMerge}`.

The box worker's `pr-resolve` lane (`runPrResolveJob`, [[../recipes/build-box-setup]]) then claims each resolve job and does the merge + resolve + tsc-gate + push (or rebuild-on-main / surface-to-owner). The auto-merge gate, by contrast, performs the merge inline in the webhook (one REST call) — no worker.

## Setup

Configure a repository webhook on `thecyclecoder/shopcx` → payload URL `https://shopcx.ai/api/webhooks/github`, content type `application/json`, secret = the `GITHUB_WEBHOOK_SECRET` env value, events: **Pushes** + **Pull requests** (dirty-PR resolver) PLUS **Check suites** + **Check runs** + **Statuses** (so auto-merge fires the moment a PR's checks go green). The handler calls back into the GitHub REST API with `GITHUB_TOKEN` / `AGENT_TODO_GITHUB_TOKEN` (the same token the build console uses to list/close/merge PRs).

## Gotchas

- **`mergeable` is lazy.** Right after a push it's `null` (still computing); the detector polls the single-PR GET a few times before deciding. A still-`null` result is skipped — a later event re-checks it. See [[../libraries/github-pr-resolve]].
- **`claude/*` only.** A non-`claude/*` PR (a human PR) or a clean PR triggers nothing — the relevance filter + the `claude/*` head-ref filter + the `mergeable === false` gate all have to pass.
- **Repo-level, one workspace.** No per-workspace secret/lookup (unlike the [[shopify|Shopify]] / Appstle webhooks) — one repo serves one build console, so the job attaches to the build-console workspace.
- **Idempotent.** `push` + `synchronize` can both fire for the same change; `enqueuePrResolveJob` dedupes one active job per PR. Auto-merge is naturally idempotent (a merged PR is no longer open/clean) and serialized (one merge per pass).
- **Auto-merge kill-switch + sync-aware.** Gate A no-ops while `workspaces.auto_merge_enabled === false` or an Inngest [[../tables/sync_jobs|sync]] is active (a deploy would reap it). Registered in the [[../libraries/control-tower]] as the `auto-merge-gate` reactive loop — every pass beats, every merged PR # is in `produced` + the log.
- **Security pass on every merge.** A merged `claude/*` build runs [[../libraries/agent-jobs]] `applyMergedBuildEffects`, which fires the per-diff security pass ([[../libraries/security-agent]] `enqueueSecurityReviewJob`, deduped by merge SHA) — the supervisor on the auto-merge proxy ([[../specs/security-dependency-agent]] Phase 1).
