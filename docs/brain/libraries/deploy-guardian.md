# libraries/deploy-guardian

**Reva, the Deploy Guardian** ([[../specs/deploy-health-rollback-guardian]]). The supervisor on the auto-merge proxy. Auto-merge ([[github-pr-resolve]] `autoMergeReadyPrs`) optimizes "ship the fix"; its degenerate state is shipping a fix that breaks something else and leaving it live. Reva watches each auto-merged `claude/<slug>` deploy over a bounded **canary window** and stamps a verdict — Phase 2 will restore-known-good FAST on a clear regression; Phase 1 (this file) **watches + stamps only**.

**File:** `src/lib/deploy-guardian.ts` · state: [[../tables/deploy_watches]] · eval cron: [[../inngest/deploy-guardian-cron]]

## Why

The director auto-merges its own error fixes ([[../specs/director-zero-backlog-error-autonomy]]), but no worker owned "this deploy just went live; did it regress prod?" — Bo merges, Vera checks a spec's own verification, Tao watches loops, none owns post-deploy health. Reva is the missing supervisor: it reuses Tao's Control-Tower signals + the error feed (no new monitoring substrate) and is the only thing that ties a NEW regression back to the deploy that caused it.

## The flow (open → window → evaluate → verdict)

1. **Open** — the moment the auto-merge gate squash-merges a build branch ([[github-pr-resolve]] `autoMergeReadyPrs`), it calls `openDeployWatch`. That snapshots the **pre-deploy baseline** (existing error signatures + already-open loop_alerts) and inserts a `pending` [[../tables/deploy_watches]] row with `window_ends_at = deployed_at + CANARY_WINDOW_MS`.
2. **Window** — a bounded canary window (`CANARY_WINDOW_MS`, default **12 min**, the spec's 10–15 min band; env `DEPLOY_GUARDIAN_CANARY_WINDOW_MS`).
3. **Evaluate** — [[../inngest/deploy-guardian-cron]] runs every minute and calls `evaluateDueDeployWatches`, which evaluates each `pending` watch whose window has elapsed.
4. **Verdict** — `healthy` ｜ `regressed` ｜ `unsure`, stamped on the watch row + a [[../tables/director_activity]] row.

## The correlation gate

Only signals that **FIRST appear AFTER the deploy timestamp** are attributed to the deploy (mirroring [[../specs/agent-outage-resilience]]'s outage-correlation tagging):

- **NEW error signatures** — [[../tables/error_events]] rows with `first_seen_at >= deployed_at`, `outage_correlated = false` (outage symptoms aren't this deploy's fault), and the signature NOT in the pre-deploy baseline.
- **NEW red loops** — [[../tables/loop_alerts]] rows `status='open'` with `opened_at >= deployed_at`, the `loop_id` NOT already open at deploy time.
- **Control-Tower cross-check** — the live [[control-tower]] `buildControlTowerSnapshot` red-loop count (a degraded snapshot is recorded `controlTowerOk:false`, never silently dropped).

## Exports

### `openDeployWatch({ admin, branch, prNumber?, mergeSha?, deployedAt? }): Promise<string | null>`
Open a watch for a just-auto-merged `claude/<slug>` deploy. Resolves the owning workspace + spec slug from the branch's most recent `kind='build'` [[../tables/agent_jobs]] row (no build job ⇒ not the director's auto-fix path ⇒ no-op), snapshots the baseline, inserts a `pending` watch. Idempotent on `merge_sha` (a `23505` on the partial unique index is a no-op, not an error). **Best-effort + never throws** — a watch that crashes the merge it guards is worse than the gap. Returns the watch id or `null`.

### `evaluateDueDeployWatches(admin): Promise<{ due, evaluated }>`
The cron driver: find every `pending` watch past its `window_ends_at` (bounded to 25/tick) and evaluate each. Never throws.

### `evaluateDeployWatch(admin, watch): Promise<DeployVerdict>`
Evaluate ONE watch: gather findings → `verdictFor` → stamp the row (idempotent: only the first evaluator flips `pending`) + write a `deploy_healthy`/`deploy_regressed`/`deploy_unsure` [[../tables/director_activity]] row.

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

## North star

Reva is the **supervisor** on the auto-merge proxy: it surfaces a verdict (and in Phase 2 takes the conservative, reversible action — restore known-good — on a clear regression, escalating anything ambiguous). It does not replace the deploy/error/loop signals; it supervises them. See [[../operational-rules#north-star]].

## Callers

- [[github-pr-resolve]] `autoMergeReadyPrs` → `openDeployWatch` (the open path).
- [[../inngest/deploy-guardian-cron]] → `evaluateDueDeployWatches` (the eval path).

## Related

[[../specs/deploy-health-rollback-guardian]] · [[../tables/deploy_watches]] · [[../inngest/deploy-guardian-cron]] · [[github-pr-resolve]] · [[control-tower]] · [[director-activity]] · [[../tables/error_events]] · [[../tables/loop_alerts]] · [[../goals/devops-director]] · [[../specs/agent-outage-resilience]] · [[../specs/regression-agent]]
