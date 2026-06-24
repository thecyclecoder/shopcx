# Regression backlog reconciliation — guarantee coverage + drain the backlog ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[regression-agent]] — the standing-coverage complement to Remi; the regression-side sibling of [[director-zero-backlog-error-autonomy]] under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO asked who handles regressions — 'we have quite a few.' Remi (the [[regression-agent]]) IS built and owns them, but it has fired ZERO times (0 `regression` jobs, no `detected_regression`/`authored_fix` activity) while Vera's spec-test returned `issues` on several specs. Root cause: Remi is purely event-driven — `enqueueRegressionJob` only fires when `runSpecTestJob` happens to re-test a shipped spec and it fails. Nothing GUARANTEES every shipped spec is periodically re-verified, and nothing reconciles a detected-but-undispositioned regression. Same blind spot Rafa has on errors; [[director-zero-backlog-error-autonomy]] fixes the error side, this fixes the regression side.

## North star — coverage is the supervisor's job

Remi optimizes 'review the regression in front of me.' The degenerate state is a real regression nobody re-tested, sitting silently in a shipped feature. The Director's job is to GUARANTEE coverage — every shipped spec gets re-verified on a cadence, and every regression reaches a terminal state — without the CEO chasing it. Supervise the detector; don't rebuild it.

## Phase 1 — standing re-verification sweep (close the coverage gap) ✅
- Add `reconcileRegressionCoverage(admin)` to the [[../libraries/platform-director]] standing pass (dormant until live+autonomous). Each pass: pick the SHIPPED, unarchived specs least-recently verified (oldest [[spec_test_runs]] first, capped per pass like the groom cap) and enqueue a Vera spec-test re-run for them — so a silent regression is caught even when nothing event-triggered a re-test. An `issues` result flows to Remi through the EXISTING `enqueueRegressionJob` (no new detector).
- Bounded + idempotent: a spec re-verified within a freshness window (e.g. 7d) is skipped; a spec already queued for spec-test is not double-queued.
- Brain: [[../libraries/platform-director]] · [[regression-agent]] (`enqueueRegressionJob`) · [[spec_test_runs]] · [[../specs/spec-test-deep-verification]].

### Verification — Phase 1
- With Platform live+autonomous, a shipped spec not verified within the freshness window gets a spec-test re-run queued on the next standing pass; if it returns `issues`, a `regression` job is enqueued + a `detected_regression` activity row. A recently-verified spec is skipped (no churn).

## Phase 2 — regression backlog reconciliation (drive every regression to terminal) ⏳
- Each pass: find every shipped spec with an UNRESOLVED evidence-backed spec-test `fail` (the `getHumanTestQueue` regression definition) that has NO live `regression` job — and enqueue Remi for it (the detected-but-never-reviewed gap). Confirm in-flight regression fixes are progressing; a fix that failed ≥ `REGRESSION_LOOP_GUARD_MAX` with nothing in-flight escalates (Remi's existing loop-guard). So no regression sits undetected OR un-dispositioned.
- Mirrors [[director-zero-backlog-error-autonomy]] Phase 1 for the regression surface; writes a `reconciled_regression` [[../tables/director_activity]] row per action.

### Verification — Phase 2
- A shipped spec with an unresolved spec-test `fail` and no live regression job → a `regression` job enqueued on the next pass. A regression whose fix is in-flight is not re-enqueued. A repeatedly-failing regression fix escalates rather than re-authoring forever.

## Phase 3 — surface it on the scorecard ⏳
- Feed the daily board-watch + the [[Platform Department Scorecard]] goal: 'regressions — D detected, F fixed, R reconciled from backlog, E escalated' + a 'shipped specs re-verified this week / total' coverage number, so regression coverage is a visible KPI, not a hope.

### Verification — Phase 3
- The board-watch + scorecard show the day's regression detect/fix/reconcile/escalate counts and the re-verification coverage ratio.

## Open decision (for the CEO)
This is the regression sibling of director-zero-backlog-error-autonomy. If you'd rather have ONE reconciliation owning ALL open problems (errors + regressions + loop alerts) under a single sweep, say so and I'll merge this into that spec instead of running two — same outcome, one lane. Default here is two focused siblings (errors and regressions have different detectors and data), which is simpler to build and grade independently.