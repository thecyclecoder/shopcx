# github-pr-resolve.ts

`src/lib/github-pr-resolve.ts` — the [[../integrations/github-webhook|GitHub webhook]]'s two **mirror gates** over open `claude/*` PRs. North star (supervisable autonomy): both are bounded proxies the owner supervises (kill-switch + every action surfaced), neither force-pushes through a guardrail.

1. **Dirty-PR Resolver detection** ([[../specs/dirty-pr-resolver-agent]]) — the CONFLICTING half: detect dirty `claude/*` PRs and enqueue ONE resolver job each; the box agent (`runPrResolveJob`) owns the actual merge + the resolve-vs-rebuild-vs-human decision.
2. **Auto-merge gate** ([[../specs/auto-ship-pipeline]] Phase 1 / Gate A) — the READY half: squash-merge + delete branch ONE ready (mergeable + all-checks-green) `claude/*` PR, directly via the GitHub REST API (no box worker — the merge is one API call). Automates the owner's rubber-stamp "merge" click; serialized, sync-aware, owner kill-switch.

Touches **`claude/*` build branches only**.

## Exports

- **`verifyGithubWebhook(rawBody, signatureHeader, secret) → boolean`** — verify the `X-Hub-Signature-256` header GitHub sends (`sha256=<hex>` = HMAC-SHA256(secret, raw body)). Constant-time (`timingSafeEqual`); rejects a missing/malformed header, an unconfigured secret, or a length/digest mismatch. Mirrors [[meta]] `verifyMetaWebhookSignature` — the **raw bytes as received** MUST be used (JSON re-encoding breaks the digest). Secret = `GITHUB_WEBHOOK_SECRET`.
- **`detectAndEnqueueDirtyPrs(admin?) → DirtyPrResult`** — the webhook's whole job: list open PRs, keep `claude/*` ones, check each `mergeable`, enqueue a deduped `pr-resolve` job for the newly-`CONFLICTING` ones. Best-effort + bounded — a transient GitHub error on one PR doesn't block the rest. Returns `{ checked, conflicting, enqueued, prs[] }`.
- **`enqueuePrResolveJob(admin, { workspaceId, prNumber, branch, reason? }) → { enqueued, reason? }`** — insert a `kind='pr-resolve'` [[../tables/agent_jobs]] row (`spec_slug = pr-{number}`, `spec_branch = branch`, `pr_number`, `instructions = {pr_number, branch, reason}`). **Idempotent:** no-op if an active pr-resolve job already exists for this PR (dedupe key = `pr-{number}`), so a burst of `push` + `synchronize` events for the same PR enqueues once.
- **`autoMergeReadyPrs(admin?) → AutoMergeResult`** (Gate A) — list open `claude/*` PRs, find the READY ones (open · non-draft · `mergeable === true` · `mergeable_state === "clean"`), squash-merge **ONE** (serialized) + delete its branch via the GitHub REST API. No-op when the kill-switch is off or a sync is active. Beats the Control Tower (`loop_id = AUTO_MERGE_GATE_LOOP_ID`, `kind:'reactive'`) once per pass in a `finally`. Returns `{ enabled, syncActive, checked, ready, merged (0|1), mergedPr?, prs[] }`.
- **`isAutoMergeEnabled(admin) → boolean`** — the Gate A kill-switch: reads `workspaces.auto_merge_enabled` for the build-console workspace via `select("*")`. **Default ENABLED** — only an explicit `=== false` pauses it; a missing column (pre-migration) or a read error ⇒ enabled.
- **`isInngestSyncActive(admin) → boolean`** — true when a [[../tables/sync_jobs]] row is `pending`/`running` AND created within the last 2 h (recency-guarded so a stale 'running' row can't block forever). Gate A defers while true (a deploy would reap the running sync — the standing rule).
- Types `DirtyPrResult`, `AutoMergeResult`.

## Mergeable / mergeable_state is lazy

GitHub computes `mergeable` + `mergeable_state` **asynchronously** — `null`/`"unknown"` on the `GET /pulls` list endpoint and right after a push to `main` or while checks run, then settles a moment later. Both gates poll the single PR up to 4× (~1.2s apart) until it settles; unsettled after the budget = skip (a later event re-checks).

- Dirty gate: `fetchMergeable` settles on `mergeable` — only `mergeable === false` (CONFLICTING) enqueues.
- Auto-merge gate: `fetchReadyPr` settles on **both** `mergeable` AND `mergeable_state` (a PR can be `mergeable===true` while its state is still `"unknown"` mid-check). `mergeable_state === "clean"` is the canonical **all-green** signal: mergeable AND every commit status / check passing AND not behind. `"unstable"` (a non-required check failing/pending), `"blocked"` (a required check failing/pending), `"dirty"` (conflicts → the resolver), `"behind"`, `"draft"` are all NOT ready → left alone. The squash-merge is pinned to the evaluated head `sha` (TOCTOU guard — GitHub 409s if the head moved).

## Workspace

A repo-level webhook isn't workspace-scoped, so `resolveBuildWorkspaceId(admin)` attaches the job to the **build-console workspace** — the most-recent `agent_jobs.workspace_id` (i.e. the workspace that actually runs builds), falling back to the first `workspaces` row. Mirrors the system-level enqueue pattern in [[../inngest/spec-test-cron]].

## Callers

- [[../integrations/github-webhook]] (`POST /api/webhooks/github`) — calls `verifyGithubWebhook`, then `detectAndEnqueueDirtyPrs` on `push` to `main` / `pull_request` opened·synchronize·reopened·ready_for_review, AND `autoMergeReadyPrs` on those PLUS `check_suite`/`check_run` completed / `status` success (the events that flip a PR to READY).

## Gotchas

- **`claude/*` only.** Both gates filter `head.ref` to `claude/*` before doing anything — a human PR or `main` is never touched (guardrail).
- **Detection ≠ resolution (dirty gate).** This library only *enqueues* the resolve. The merge, the additive conflict resolution, the **tsc gate**, the push, and the rebuild-on-main / surface-to-owner decision all live in `scripts/builder-worker.ts` `runPrResolveJob` (the `pr-resolve` lane). See [[../recipes/build-box-setup]] + [[../tables/agent_jobs]].
- **Auto-merge IS the action (Gate A).** Unlike the dirty gate, `autoMergeReadyPrs` performs the squash-merge itself in the webhook — no box worker, no `tsc` gate (the build already tsc-passed before the PR opened; green CI is the gate). The post-merge [[../specs/spec-test-on-ship|spec-test-on-ship]] is the safety net for a bad-but-green build.
- **Serialized.** Gate A merges at most ONE PR per pass; the resulting push-to-main webhook re-enters the gate to merge the next — so N ready PRs never fan out to N simultaneous Vercel deploys.
- **Idempotent + deduped (dirty gate).** One active pr-resolve job per PR; a PR it can't fix lands `needs_attention` (surfaced) or is rebuilt, never retried in a loop.
