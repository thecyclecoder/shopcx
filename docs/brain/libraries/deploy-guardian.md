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
- **NEW red loops** — [[../tables/loop_alerts]] rows `status='open'` with `opened_at >= deployed_at`, the `loop_id` NOT already open at deploy time, AND not a **non-deploy-attributable** `kpi_drift` loop (see the blast-radius filter below).

**Blast-radius filter (`isExcludedFromDeployRegression`).** A second correlation filter alongside `outage_correlated`: a Vercel CODE deploy has **no causal path** to certain error classes, so they're dropped from the new-error spike (still surfaced on the error feed — just never an auto-revert trigger). Two classes, both env-overridable:
- **`source='supabase-logs'`** — the Supabase DB-log poller's edge-API 5xx / `context canceled` / auth-gateway errors. These are Postgres/PostgREST/GoTrue's OWN gateway blips (platform-wide, hit unrelated routes like `/auth/v1/user`, `/rest/v1/specs`); a deploy ships functions, it can't make Supabase return 502. Same exclusion class as an outage. Re-arm with `DEPLOY_GUARDIAN_INCLUDE_INFRA_SOURCES=1`.
- **`UserGeneratedError:` titles** — Appstle / business-state errors that fire on the customer's billing cadence, not the code path (e.g. "Subscription contract cannot be updated if there is a current/upcoming billing-cycle edit"). A user/business-state condition, not a code fault.

**Loop blast-radius filter (`isExcludedFromDeployRegressionLoop`).** The loop-side twin of the above — a NEW red `loop_alerts` row is dropped from `newRedLoops` in **two** classes:

- **Audit-skipped `kpi_drift` metrics** — a `kpi_drift:<metric>:<cadence>` alert for a metric whose registry marks it `liveSpecSetDependent` (weekly-aggregate / live-spec-set meta: `specs_per_week`, `regression_coverage_pct`, …) or `currentState` (point-read: `lane_utilization`, …). These reflect **PM volume / a moving-population membership delta**, NOT the deployed code — a no-op spec's deploy cannot move them. Predicate: [[platform-scorecard]] `isAuditSkippedKpiDriftLoop`, which consults the **same registry flags** [[kpi-review]] `auditAllKpis` skips ([[../specs/kpi-audit-skip-live-spec-set-dependent-metrics]] / #848) — **single source of truth**, so the audit skip and the deploy-attribution gate can't drift apart.
- **MONTHLY-cadence `kpi_drift` — any metric** (`isMonthlyKpiDriftLoop`). A monthly kpi_drift is a **trailing 30-day aggregate**; the canary window is minutes to hours, so a single deploy cannot causally move a 30-day ratio inside it — attributing one deploy to it is a category error at the timescale level. Excluded regardless of the metric's registry classification (the `human_touch_per_build:monthly` false-revert wasn't `liveSpecSetDependent`, it was just too laggy).

A genuine **DAILY** windowed-aggregate `kpi_drift`, an error-rate loop, or a test/regression loop is NOT excluded and still trips `regressed`.

**Reasoning surfaced on the decision.** Excluded loops that opened in the window are not silently dropped — they're recorded on `deploy_watches.findings.excludedRedLoops = [{ loop_id, excluded_reason }, …]` and on the `director_activity.metadata.excluded_red_loops` row, so the supervisor can audit which signals were considered and which were dropped, and why. (Reason surfacer: `reasonExcludedFromDeployRegressionLoop`.)

> The error filter closed the [[../specs/build-card-lifecycle-timeline]] Phase 3 incident: a fold-gate diff (`getAutoFoldEligibleSlugs` security-gating) was auto-reverted twice — once on a 1-second burst of 7 `supabase-logs` 502s, once on a recurring Appstle `UserGeneratedError` — neither touchable by the merged code (both watches `newRedLoops:[]`). The temporal-only gate had mis-attributed two foreign signals that merely shared the canary window.
>
> The audit-skipped loop filter + diff-plausibility gate closed the **`noop-pipeline-test-6`** false-revert: Reva auto-reverted a NO-OP spec because two **weekly-aggregate** `kpi_drift` loops (`specs_per_week`, `regression_coverage_pct`) flipped red in its canary window from a high-volume PM night. Those loops reflect PM volume, not the deploy.
>
> The monthly-cadence loop filter closes the **`blog-pixel-tracking`** spurious-rollback: Reva auto-rolled back a storefront pixel on a single `kpi_drift:human_touch_per_build:monthly` red loop — a **build-pipeline autonomy KPI a storefront pixel cannot causally affect** — and the alert self-resolved 50 min later. Monthly kpi_drift is a 30-day trailing ratio; a canary window can't attribute changes to one deploy. A deploy may now be auto-rolled-back ONLY on signals a deploy can plausibly move at deploy timescale (errors, a windowed-aggregate DAILY kpi_drift, a real test/regression loop) — never a monthly kpi_drift or a PM-volume aggregate.
- **Control-Tower cross-check** — the live [[control-tower]] `buildControlTowerSnapshot` red-loop count (a degraded snapshot is recorded `controlTowerOk:false`, never silently dropped).

## Exports

### `openDeployWatch({ admin, branch, prNumber?, mergeSha?, deployedAt?, workspaceId?, slug?, isAtomic? }): Promise<string | null>`
Open a watch over a just-merged deploy. **Per-spec path** (default): a `claude/<slug>` branch — resolves the owning workspace + spec slug from the branch's most recent `kind='build'` [[../tables/agent_jobs]] row (no build job ⇒ no-op). **Atomic path** (M5): the caller (`promoteCompleteGoalsToMain`) passes `workspaceId` + `slug` (the goal slug) + `isAtomic:true` for a `goal/<slug>` deploy — the branch has no single build job, so the lookup is skipped and the watch is stamped `is_atomic` (→ escalate-not-revert). Snapshots the baseline, inserts a `pending` watch. Idempotent on `merge_sha` (a `23505` on the partial unique index is a no-op). Tolerates the pre-migration schema: an insert that hits an unknown `is_atomic` column (42703) retries without it. **Best-effort + never throws**. Returns the watch id or `null`.

### `evaluateDueDeployWatches(admin): Promise<{ due, evaluated }>`
The cron driver: find every `pending` watch past its `window_ends_at` (bounded to 25/tick) and evaluate each. Never throws.

### `evaluateDeployWatch(admin, watch): Promise<DeployVerdict>`
Evaluate ONE watch: gather findings → `verdictFor` → **CLAIM** the row (`update … where verdict='pending' returning id`; only the winner acts — the idempotency spine) → route on shape. Under [[../specs/reva-box-session-causal-rollback]] Phase 1 the cron **stops deciding** on non-healthy verdicts: `healthy` still stamps + records `deploy_healthy` (unchanged fast path); atomic (`is_atomic=true`) non-healthy escalates directly (never routed through per-signal review — reverting a whole tested goal is far costlier than a per-phase revert); per-spec non-healthy under the loop-guard **stamps `verdict='in_review'` + enqueues one `kind='deploy-review'` [[../tables/agent_jobs]] row** (Reva reads the merge_sha's real diff on Max via `runDeployReviewJob` — Phase 2 — and returns a typed verdict the worker applies via `applyBoxDeployReview` — Phase 3, the mutator); per-spec non-healthy with the loop-guard TRIPPED escalates + halts without enqueueing. Each acted watch still writes a matching [[../tables/director_activity]] row.

### `applyBoxDeployReview(admin, jobId, verdict): Promise<ApplyBoxDeployReviewResult>` — [[../specs/reva-box-session-causal-rollback]] Phase 3

The **only mutator** on the box-session path — the deterministic writer that applies Reva's typed causal-review verdict (`{ decision: 'revert'|'keep'|'escalate', signals: [{ key, surface, caused, evidence }], reasoning }`) returned by the Phase-2 box session (`runDeployReviewJob`, `scripts/builder-worker.ts`) to the watch behind ONE `kind='deploy-review'` [[../tables/agent_jobs]] row. Mirrors [[agent-grader]] `applyBoxGrade` in shape: the box session diagnoses read-only + emits a typed verdict, and this function claims + applies it. **Concurrency-safe + idempotent:** the atomic pending-guard is `update deploy_watches set … where verdict='in_review' returning id` — only the caller that wins the claim acts, so a re-apply / a concurrent tick / a redriven job never double-reverts. Every decision writes `findings.reva_review = { decision, signals, reasoning, reviewed_by:'box-session' }` (no new column — per the [[../tables/deploy_watches]] findings pattern), preserving all prior findings keys.

- `decision='revert'` — check the **loop-guard** first (`priorRollbacksForSlug` ≥ `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`). Tripped ⇒ escalate + stamp `verdict='regressed'` + `findings.rollback={status:'loop_guard', prior_rollbacks}` + `deploy_regressed` [[../tables/director_activity]] row + a critical [[../integrations/slack]] ops alert — **no revert** (same conservative move `actOnRegression` made; a rollback-then-reland loop is a deeper issue). Untripped ⇒ CLAIM (`in_review → regressed`) + call `revertDeployMerge` (the standalone hand at line 584); a clean revert stamps `findings.rollback={status:'reverted', revert_sha, prior_rollbacks}` + escalates + writes `deploy_rolled_back`; a conflict/failed revert stamps `findings.rollback={status:'revert_failed'|'conflict', reason}` + critical ops alert + `deploy_regressed` (prod still on the regressed build — manual revert needed).
- `decision='keep'` — CLAIM (`in_review → healthy`) + `deploy_kept` activity. No revert, no escalation — Reva affirmed no causal path; the reasoning goes on the activity row.
- `decision='escalate'` — CLAIM (`in_review → unsure`) + `escalateDiagnosisToCeo` (dedupe `deploy-reva-escalate:{watch.id}`) + `deploy_unsure` activity. A plausible but unconfirmable causal path escalates for a human; never revert on doubt.

Returns `{ ok, reason?, finalVerdict?, revertSha?, loopGuarded? }` — surfaced back to the Phase-2 runner for `agent_jobs.log_tail`. **Never throws** — caught errors return `{ ok:false, reason }`.

### `revertDeployMerge({ mergeSha, slug, prNumber? }): Promise<RevertResult>` — Phase 2
Restore known-good by reverting the offending squash-merge **via the GitHub git-data API** (no local git — the cron runs in the Vercel/Inngest runtime, reusing [[github-pr-resolve]]'s `GITHUB_TOKEN`/`AGENT_TODO_REPO`). A squash merge is single-parent, so: if nothing landed since (`HEAD === mergeSha`, the common case under the serialized auto-merge gate) it restores the **parent tree verbatim** (the prior good build, byte-for-byte); else it does a **true single-commit revert** of only this deploy's files (`buildRevertTree` — restore each to the parent version, **bail to a conflict** if a later commit touched it or the tree is truncated). Creates the revert commit on top of HEAD + fast-forwards `main`. **Never throws** — returns `{ reverted, revertSha?, reason?, conflict? }`; the caller escalates on `!reverted`.

### `actOnRegression` (internal) + `priorRollbacksForSlug`, `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`
The `regressed`-verdict action rule. **Diff-plausibility gate (first):** `classifyDeployDiff` fetches the deploy's changed files and, if **every** path is runtime-INERT (`isRuntimeInertPath` — `docs/`, `*.md`/`*.mdx`/`*.txt`, `supabase/migrations/` ledger, non-behavioral config/lockfiles), it ESCALATES (`deploy_inert_noregress`) instead of reverting — a no-op/docs-only diff cannot cause a runtime regression, so the red signal is foreign. **Fails OPEN:** an unreadable diff, or one touching any source (`.ts`/`.tsx`/route/env), falls through to the revert path (never suppresses a real rollback). **Loop-guard:** `priorRollbacksForSlug` counts this slug's `deploy_rolled_back` activity rows in the last 7 days; at `≥ DEPLOY_GUARDIAN_LOOP_GUARD_MAX` (default **2**, env `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`) it STOPS auto-reverting + escalates a "deeper issue" (critical ops alert). Else it `revertDeployMerge`s and escalates the diagnosis carrying the revert SHA (`deploy_rolled_back`). A revert that can't run cleanly (conflict / missing SHA / API error) → escalate critically for a **manual** rollback (`deploy_regressed`; prod still on the regressed build). All escalations go through [[platform-director]] `escalateDiagnosisToCeo` (deduped per watch). The rollback outcome is stamped into `deploy_watches.findings.rollback`.

### `gatherDeployFindings(admin, watch): Promise<DeployWatchFindings>`
The sampler — applies the correlation gate above and returns `{ newErrorSignatures, newRedLoops, excludedRedLoops, redLoopCount, controlTowerOk }`. `excludedRedLoops` records loops that opened in the window but were dropped as not causally deploy-scoped (monthly kpi_drift, audit-skipped meta-metrics) with a per-loop `excluded_reason`, so the rollback decision is auditable.

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
- **`DEPLOY_GUARDIAN_AUTOREVERT_MODE`** ([[../specs/reva-box-session-causal-rollback]] Phase 4) — the **kill-switch**. `'box'` (default) → full box-session path (enqueue review → apply typed verdict → revert on 'revert'). `'off'` → **surface-only**: the cron still enqueues Reva, `applyBoxDeployReview` still stamps + writes activity + preserves `findings.reva_review`, BUT a `decision='revert'` is DEGRADED to the escalate path (never calls `revertDeployMerge`). Flip to `'off'` when Reva is producing false positives or during a controlled experiment — "eyes open, hands tied."
- **`DEPLOY_GUARDIAN_SAME_SURFACE_FASTPATH`** ([[../specs/reva-box-session-causal-rollback]] Phase 4) — the **optional fast-path**. `'1'` → a deterministic same-surface high-count match (a new error whose `sample.path` matches a changed file's route AND `count ≥ DEPLOY_REGRESSION_MIN_COUNT`) may revert immediately, skipping Reva's session. **OFF by default** until validated against the 2026-07-04 fixtures — a false fast-path revert is exactly what the whole causal-review effort exists to prevent.

## Fail-safe (Phase 4) — never revert without a judgment

Reva's box session can die: an idle-kill, a session hardcap, a stream that never emits parseable JSON, a runner throw before `applyBoxDeployReview` fires. The fail-safe (`failsafeStampWatchUnsure` in [[deploy-guardian]]) guarantees the watch never sits stuck at `verdict='in_review'` (which would evade the cron's pending-window read + leave it silently invisible). The default is **keep + escalate, NOT revert**: an unsure stamp + a CEO escalation, because absence-of-judgment means absence-of-evidence — the conservative move is to surface, not roll back.

Called by `runDeployReviewJob` (scripts/builder-worker.ts) on: (a) no parseable verdict from the session, (b) an exception in the runner's try/catch, (c) `applyBoxDeployReview` returned `{ok:false}` without resolving the watch past `in_review`. Idempotent + concurrency-safe via the same `update … where verdict='in_review' returning id` atomic pending-guard the mutator uses — a fail-safe call after a normal apply is a no-op, and a concurrent fail-safe/redriven-job call from a re-run no-ops on the second caller. Writes `findings.reva_review = { decision:'escalate', signals:[], reasoning:<why the fail-safe fired>, reviewed_by:'box-session-failsafe' }` so the audit trail names the failsafe as the author. **Best-effort + never throws.**

## North star

Reva is the **supervisor** on the auto-merge proxy: it surfaces a verdict (and in Phase 2 takes the conservative, reversible action — restore known-good — on a clear regression, escalating anything ambiguous). It does not replace the deploy/error/loop signals; it supervises them. See [[../operational-rules#north-star]].

## The Reva box session (reva-box-session-causal-rollback Phase 2)

A `kind='deploy-review'` [[../tables/agent_jobs]] row (enqueued by `evaluateDeployWatch` on a per-spec non-healthy watch under the loop-guard) is claimed on its own **concurrency-1 lane** (`MAX_DEPLOY_REVIEW=1`) by the box worker's `runDeployReviewJob` (`scripts/builder-worker.ts`). It launches a top-level `claude -p` on Max (no `ANTHROPIC_API_KEY`, keeps read-only DB + full repo access) running the `deploy-review` skill (Reva's persona; `GUARDIAN_ACTOR='deploy-guardian'`). The session `git show`s the `merge_sha` + `git diff`s `origin/main~1..<merge_sha>` to enumerate the deploy's real changed files; for each candidate signal (from the enqueue payload — `new_error_signatures` + `new_red_loops`) it maps the source surface (route / cron / lib) and Reads it, then decides per-signal whether the diff has a **causal path** to the surface. It returns ONE JSON object:

```
{ "decision": "revert"|"keep"|"escalate", "signals": [{ "key", "surface", "caused", "evidence" }], "reasoning" }
```

Read-only against everything (no repo writes, no DB writes, no PR). The worker (`runDeployReviewJob`) logs the verdict on `agent_jobs.log_tail` for audit and completes the job; Phase 3's `applyBoxDeployReview` (the only mutator) applies the typed verdict: `revert` → `revertDeployMerge` + `escalateDiagnosisToCeo` + `deploy_rolled_back` activity; `keep` → stamp `verdict='healthy'` + `deploy_kept` activity; `escalate` → `escalateDiagnosisToCeo` (no revert). Absence of a parseable verdict → the job parks `needs_attention` (Phase 4's fail-safe backstops the watch).

## Callers

- [[github-pr-resolve]] `autoMergeReadyPrs` → `openDeployWatch` (the open path).
- [[../inngest/deploy-guardian-cron]] → `evaluateDueDeployWatches` (the eval + enqueue path).
- [[platform-director]] `escalateDiagnosisToCeo` ← the escalation plumbing (CEO inbox).
- `scripts/builder-worker.ts` `runDeployReviewJob` — the Phase-2 box session that runs the causal review.

## Status / open work

- [[../specs/reva-box-session-causal-rollback]] Phase 5 — the backtest harness `scripts/_backtest-reva-box.ts` LANDS the go-live gate for flipping `DEPLOY_GUARDIAN_AUTOREVERT_MODE` from `'off'` to `'box'`. Curated fixture set:
  - **2026-07-04 false-revert set** (all must return `keep`): portal-external-fetch-timeout-guard (merge `3886045`), error-feed-drop-undici-headers-timeout-noise (`f3240b8`), error-feed-drop-supabase-edge-html-body-noise (`5686a78`), error-feed-scope-supabase-auth-504-gateway-timeout-transient (`708dd73`).
  - **Historical false-revert classes** (all must return `keep`): build-card-lifecycle-timeline (fold-gate diff mis-attributed to a `supabase-logs` burst + Appstle `UserGeneratedError`), blog-pixel-tracking (mis-attributed to `kpi_drift:*:monthly`), noop-pipeline-test-6 (mis-attributed to weekly-aggregate `kpi_drift`).
  - **Synthetic positive** (must return `revert`): a same-surface high-count error whose sample.path is a portal handler the diff literally touched.
- **Dry-run** (`npx tsx scripts/_backtest-reva-box.ts`) is CI-safe — prints each fixture's brief for the operator to eyeball. **Live** (`--run`) spawns `claude -p` per fixture on Max, parses the returned JSON verdict, and exits non-zero on any mismatch. Wall-clock ≈ 15 min for the full set.
- **Go-live gate:** every fixture must PASS with `--run` before the operator flips `DEPLOY_GUARDIAN_AUTOREVERT_MODE=box` in the box's systemd EnvironmentFile + restarts the worker. Until then the guardian is in surface-only mode (see [[#Constants]] the kill-switch env) — Reva still runs, records `findings.reva_review`, and writes activity, but never calls `revertDeployMerge`.

## Related

[[../specs/deploy-health-rollback-guardian]] · [[../specs/reva-box-session-causal-rollback]] · [[../tables/deploy_watches]] · [[../inngest/deploy-guardian-cron]] · [[github-pr-resolve]] · [[control-tower]] · [[director-activity]] · [[../tables/error_events]] · [[../tables/loop_alerts]] · [[../goals/devops-director]] · [[../specs/agent-outage-resilience]] · [[../specs/regression-agent]] · [[../lifecycles/spec-goal-branch-pm-flow]]
