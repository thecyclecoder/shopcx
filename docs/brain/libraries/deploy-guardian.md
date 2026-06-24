# libraries/deploy-guardian

**Reva, the Deploy Guardian** ([[../specs/deploy-health-rollback-guardian]]). The supervisor on the auto-merge proxy. Auto-merge ([[github-pr-resolve]] `autoMergeReadyPrs`) optimizes "ship the fix"; its degenerate state is shipping a fix that breaks something else and leaving it live. Reva watches each auto-merged `claude/<slug>` deploy over a bounded **canary window**, stamps a verdict, and — on a clear regression — **restores known-good FAST** (an auto-revert of the offending merge) + escalates, escalating anything ambiguous rather than guess. Phase 1 = watch + stamp; **Phase 2 = act** (auto-rollback + CEO escalation).

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

- **NEW error signatures** — [[../tables/error_events]] rows with `first_seen_at >= deployed_at`, `outage_correlated = false` (outage symptoms aren't this deploy's fault), and the signature NOT in the pre-deploy baseline.
- **NEW red loops** — [[../tables/loop_alerts]] rows `status='open'` with `opened_at >= deployed_at`, the `loop_id` NOT already open at deploy time.
- **Control-Tower cross-check** — the live [[control-tower]] `buildControlTowerSnapshot` red-loop count (a degraded snapshot is recorded `controlTowerOk:false`, never silently dropped).

## Exports

### `openDeployWatch({ admin, branch, prNumber?, mergeSha?, deployedAt? }): Promise<string | null>`
Open a watch for a just-auto-merged `claude/<slug>` deploy. Resolves the owning workspace + spec slug from the branch's most recent `kind='build'` [[../tables/agent_jobs]] row (no build job ⇒ not the director's auto-fix path ⇒ no-op), snapshots the baseline, inserts a `pending` watch. Idempotent on `merge_sha` (a `23505` on the partial unique index is a no-op, not an error). **Best-effort + never throws** — a watch that crashes the merge it guards is worse than the gap. Returns the watch id or `null`.

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
