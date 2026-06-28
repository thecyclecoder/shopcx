# libraries/deploy-guardian

**Reva, the Deploy Guardian** ([[../specs/deploy-health-rollback-guardian]]). The supervisor on the auto-merge proxy. Auto-merge ([[github-pr-resolve]] `autoMergeReadyPrs`) optimizes "ship the fix"; its degenerate state is shipping a fix that breaks something else and leaving it live. Reva watches each merged deploy over a bounded **canary window**, stamps a verdict, and acts. **Two deploy shapes** (spec-goal-branch-pm-flow M5):
- **Per-spec** — a `claude/<slug>` build branch squash-merged to main (Gate A, one-off specs). A clear regression **restores known-good FAST** (auto-revert of the offending merge) + escalates.
- **Atomic** — a `goal/<slug>` branch promoted to main in ONE merge (Gate C / M5, carrying many specs). Marked `deploy_watches.is_atomic`. A regression here **ESCALATES, never auto-reverts** — rolling back a whole tested goal on a regression bar tuned for tiny per-phase diffs would be a false-revert of many specs' work; a human decides (revert the goal merge, hotfix-forward, or accept).

Anything ambiguous escalates rather than guesses. Phase 1 = watch + stamp; **Phase 2 = act** (auto-rollback for per-spec / escalate for atomic + CEO escalation).

**File:** `src/lib/deploy-guardian.ts` · state: [[../tables/deploy_watches]] · eval cron: [[../inngest/deploy-guardian-cron]]

## Why

The director auto-merges its own error fixes ([[../specs/director-zero-backlog-error-autonomy]]), but no worker owned "this deploy just went live; did it regress prod?" — Bo merges, Vera checks a spec's own verification, Tao watches loops, none owns post-deploy health. Reva is the missing supervisor: it reuses Tao's Control-Tower signals + the error feed (no new monitoring substrate) and is the only thing that ties a NEW regression back to the deploy that caused it.

## The flow (open → window → evaluate → verdict)

1. **Open** — the moment the auto-merge gate squash-merges a build branch ([[github-pr-resolve]] `autoMergeReadyPrs`), it calls `openDeployWatch`. That snapshots the **pre-deploy baseline** (existing error signatures + already-open loop_alerts) and inserts a `pending` [[../tables/deploy_watches]] row with `window_ends_at = deployed_at + CANARY_WINDOW_MS`.
2. **Window** — a bounded canary window (`CANARY_WINDOW_MS`, default **12 min**, the spec's 10–15 min band; env `DEPLOY_GUARDIAN_CANARY_WINDOW_MS`).
3. **Evaluate** — [[../inngest/deploy-guardian-cron]] runs every minute and calls `evaluateDueDeployWatches`, which evaluates each `pending` watch whose window has elapsed.
4. **Verdict** — `healthy` ｜ `regressed` ｜ `unsure`, stamped on the watch row + a [[../tables/director_activity]] row.
5. **Act (Phase 2)** — `evaluateDeployWatch` **claims** the watch atomically before acting (so a concurrent tick can't double-revert), then: `regressed` → restore known-good (`revertDeployMerge`) + escalate the diagnosis; `unsure` → escalate, never auto-act; `healthy` → log. A slug stuck in a rollback-then-reland loop trips the loop-guard (STOP + escalate the deeper issue).

## The correlation gate

Only signals that **FIRST appear AFTER the deploy timestamp** are attributed to the deploy (mirroring [[../specs/agent-outage-resilience]]'s outage-correlation tagging):

- **NEW error signatures** — [[../tables/error_events]] rows with `first_seen_at >= deployed_at`, `outage_correlated = false` (outage symptoms aren't this deploy's fault), the signature NOT in the pre-deploy baseline, AND not a **blast-radius-excluded** infra/user-state signal (see below).
- **NEW red loops** — [[../tables/loop_alerts]] rows `status='open'` with `opened_at >= deployed_at`, the `loop_id` NOT already open at deploy time.

**Blast-radius filter (`isExcludedFromDeployRegression`).** A second correlation filter alongside `outage_correlated`: a Vercel CODE deploy has **no causal path** to certain error classes, so they're dropped from the new-error spike (still surfaced on the error feed — just never an auto-revert trigger). Two classes, both env-overridable:
- **`source='supabase-logs'`** — the Supabase DB-log poller's edge-API 5xx / `context canceled` / auth-gateway errors. These are Postgres/PostgREST/GoTrue's OWN gateway blips (platform-wide, hit unrelated routes like `/auth/v1/user`, `/rest/v1/specs`); a deploy ships functions, it can't make Supabase return 502. Same exclusion class as an outage. Re-arm with `DEPLOY_GUARDIAN_INCLUDE_INFRA_SOURCES=1`.
- **`UserGeneratedError:` titles** — Appstle / business-state errors that fire on the customer's billing cadence, not the code path (e.g. "Subscription contract cannot be updated if there is a current/upcoming billing-cycle edit"). A user/business-state condition, not a code fault.

> This filter closed the [[../specs/build-card-lifecycle-timeline]] Phase 3 incident: a fold-gate diff (`getAutoFoldEligibleSlugs` security-gating) was auto-reverted twice — once on a 1-second burst of 7 `supabase-logs` 502s, once on a recurring Appstle `UserGeneratedError` — neither touchable by the merged code (both watches `newRedLoops:[]`). The temporal-only gate had mis-attributed two foreign signals that merely shared the canary window.
- **Control-Tower cross-check** — the live [[control-tower]] `buildControlTowerSnapshot` red-loop count (a degraded snapshot is recorded `controlTowerOk:false`, never silently dropped).

## Exports

### `openDeployWatch({ admin, branch, prNumber?, mergeSha?, deployedAt?, workspaceId?, slug?, isAtomic? }): Promise<string | null>`
Open a watch over a just-merged deploy. **Per-spec path** (default): a `claude/<slug>` branch — resolves the owning workspace + spec slug from the branch's most recent `kind='build'` [[../tables/agent_jobs]] row (no build job ⇒ no-op). **Atomic path** (M5): the caller (`promoteCompleteGoalsToMain`) passes `workspaceId` + `slug` (the goal slug) + `isAtomic:true` for a `goal/<slug>` deploy — the branch has no single build job, so the lookup is skipped and the watch is stamped `is_atomic` (→ escalate-not-revert). Snapshots the baseline, inserts a `pending` watch. Idempotent on `merge_sha` (a `23505` on the partial unique index is a no-op). Tolerates the pre-migration schema: an insert that hits an unknown `is_atomic` column (42703) retries without it. **Best-effort + never throws**. Returns the watch id or `null`.

### `evaluateDueDeployWatches(admin): Promise<{ due, evaluated }>`
The cron driver: find every `pending` watch past its `window_ends_at` (bounded to 25/tick) and evaluate each. Never throws.

### `evaluateDeployWatch(admin, watch): Promise<DeployVerdict>`
Evaluate ONE watch: gather findings → `verdictFor` → **CLAIM** the row (`update … where verdict='pending' returning id`; only the winner acts — the idempotency spine for the revert) → ACT on the verdict (Phase 2 `actOnRegression` on `regressed`; escalate on `unsure`; log on `healthy`) → write a `deploy_healthy`/`deploy_rolled_back`/`deploy_regressed`/`deploy_unsure` [[../tables/director_activity]] row.

### `revertDeployMerge({ mergeSha, slug, prNumber? }): Promise<RevertResult>` — Phase 2
Restore known-good by reverting the offending squash-merge **via the GitHub git-data API** (no local git — the cron runs in the Vercel/Inngest runtime, reusing [[github-pr-resolve]]'s `GITHUB_TOKEN`/`AGENT_TODO_REPO`). A squash merge is single-parent, so: if nothing landed since (`HEAD === mergeSha`, the common case under the serialized auto-merge gate) it restores the **parent tree verbatim** (the prior good build, byte-for-byte); else it does a **true single-commit revert** of only this deploy's files (`buildRevertTree` — restore each to the parent version, **bail to a conflict** if a later commit touched it or the tree is truncated). Creates the revert commit on top of HEAD + fast-forwards `main`. **Never throws** — returns `{ reverted, revertSha?, reason?, conflict? }`; the caller escalates on `!reverted`.

### `actOnRegression` (internal) + `priorRollbacksForSlug`, `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`
The `regressed`-verdict action rule. **Loop-guard:** `priorRollbacksForSlug` counts this slug's `deploy_rolled_back` activity rows in the last 7 days; at `≥ DEPLOY_GUARDIAN_LOOP_GUARD_MAX` (default **2**, env `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`) it STOPS auto-reverting + escalates a "deeper issue" (critical ops alert). Else it `revertDeployMerge`s and escalates the diagnosis carrying the revert SHA (`deploy_rolled_back`). A revert that can't run cleanly (conflict / missing SHA / API error) → escalate critically for a **manual** rollback (`deploy_regressed`; prod still on the regressed build). All escalations go through [[platform-director]] `escalateDiagnosisToCeo` (deduped per watch). The rollback outcome is stamped into `deploy_watches.findings.rollback`.

### `gatherDeployFindings(admin, watch): Promise<DeployWatchFindings>`
The sampler — applies the correlation gate above and returns `{ newErrorSignatures, newRedLoops, redLoopCount, controlTowerOk }`.

### `verdictFor(findings): DeployVerdict`
The pure verdict rule:
- **`regressed`** — a new red loop, OR a clear new-error spike: `≥ DEPLOY_REGRESSION_MIN_SIGNATURES` (default **2**) distinct new signatures, OR any single new signature recurring `≥ DEPLOY_REGRESSION_MIN_COUNT` (default **3**) times in the window.
- **`healthy`** — zero new deploy-correlated errors and zero new red loops.
- **`unsure`** — exactly one new low-count signature (ambiguous; could be foreign transient noise) → escalate, never auto-act (Phase 2 owns the escalation/rollback).

### `slugFromClaudeBranch(branch): string`
`claude/<slug>` → `<slug>`.

## Constants (env-overridable)

- `CANARY_WINDOW_MS` — `DEPLOY_GUARDIAN_CANARY_WINDOW_MS`, default `12 * 60_000`.
- `DEPLOY_REGRESSION_MIN_SIGNATURES` — `DEPLOY_GUARDIAN_MIN_SIGNATURES`, default `2`.
- `DEPLOY_REGRESSION_MIN_COUNT` — `DEPLOY_GUARDIAN_MIN_COUNT`, default `3`.
- `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` — `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`, default `2` (mirrors `PLATFORM_DIRECTOR_LOOP_GUARD_MAX`).
- `MAIN_BRANCH` — `AGENT_TODO_MAIN_BRANCH`, default `main` (the branch the revert advances).
- GitHub access: `GITHUB_TOKEN` / `AGENT_TODO_GITHUB_TOKEN` + `AGENT_TODO_REPO` (default `thecyclecoder/shopcx`) — the same token the auto-merge gate uses.

## North star

Reva is the **supervisor** on the auto-merge proxy: it surfaces a verdict (and in Phase 2 takes the conservative, reversible action — restore known-good — on a clear regression, escalating anything ambiguous). It does not replace the deploy/error/loop signals; it supervises them. See [[../operational-rules#north-star]].

## Callers

- [[github-pr-resolve]] `autoMergeReadyPrs` → `openDeployWatch` (the open path).
- [[../inngest/deploy-guardian-cron]] → `evaluateDueDeployWatches` (the eval + act path).
- [[platform-director]] `escalateDiagnosisToCeo` ← the Phase-2 escalation plumbing (CEO inbox).

## Related

[[../specs/deploy-health-rollback-guardian]] · [[../tables/deploy_watches]] · [[../inngest/deploy-guardian-cron]] · [[github-pr-resolve]] · [[control-tower]] · [[director-activity]] · [[../tables/error_events]] · [[../tables/loop_alerts]] · [[../goals/devops-director]] · [[../specs/agent-outage-resilience]] · [[../specs/regression-agent]]
