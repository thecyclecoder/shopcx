# Surface regression coverage on the scorecard

**Owner:** [[../functions/platform]] · **Parent:** [[regression-agent]] — the standing-coverage complement to Remi; the regression-side sibling of [[director-zero-backlog-error-autonomy]] under [[../goals/devops-director]]

## North star — coverage is the supervisor's job

Remi optimizes 'review the regression in front of me.' The Director's job is to GUARANTEE coverage AND to make that coverage visible, so regression health is a measured KPI rather than a hope. This card covers the visibility half; the guarantee half ships under the parent.

## Phase 1 — surface it on the scorecard
- ✅ shipped — daily `regressions` metric (D detected · F fixed · R reconciled · E escalated) + weekly `regression_coverage_pct` metric in [[../libraries/platform-scorecard]], plus a dedicated `composeRegressionWatchLine` line on [[../libraries/platform-director]] `postPlatformWatchUpdate`. Brain pages refreshed.
- Feed the daily board-watch + the [[../goals/platform-department-scorecard|Platform Department Scorecard]] goal: 'regressions — D detected, F fixed, R reconciled from backlog, E escalated' + a 'shipped specs re-verified this week / total' coverage number, so regression coverage is a visible KPI, not a hope.
- Reconcile with the scorecard lane before building: [[platform-scorecard-weekly]] already owns a 'regressions caught' KPI and [[platform-scorecard-surface]] owns the page + board-watch line — extend those rather than build a parallel surface.

### What landed
- **Daily `regressions` metric** ([[../libraries/platform-scorecard]]): counts `director_activity` rows the regression worker / Platform director emit in the window — `detected_regression` (D), `authored_fix` (F), `reconciled_regression` (R), and regression-context `escalated` rows (`metadata.signature` starts `regression:`, `metadata.kind='regression'`, or `metadata.escalation_kind='loop_guard'`). Headline `value` is the sum; `detail = { detected, fixed, reconciled, escalated }`. Platform-attributed only (the [[director-xp]] real-slug guard).
- **Weekly `regression_coverage_pct` metric** ([[../libraries/platform-scorecard]]): `(distinct shipped spec_slugs with a [[../tables/spec_test_runs]] row this week) ÷ (live shipped specs from [[../libraries/brain-roadmap]] getRoadmap())` × 100. `detail = { verified, shipped, missing[] }` — the slugs still missing coverage are the same names the standing re-verification sweep ([[regression-backlog-reconciliation]] Phase 1) should pick up next pass.
- **Display tiles** ([[../libraries/platform-scorecard-display]]): "Regressions today" (daily, up_is_good) + "Re-verification coverage" (weekly, up_is_good) — rendered on `/dashboard/agents/scorecard` with the same trend-arrow + sparkline plumbing as every other tile.
- **Board-watch line** ([[../libraries/platform-director]] `postPlatformWatchUpdate`): a dedicated `Regressions: D detected · F fixed · R reconciled · E escalated · XX% coverage` line, composed by `composeRegressionWatchLine` reading the daily `regressions` detail + the weekly `regression_coverage_pct` snapshot ("read from the scorecard, never the raw tables" — the [[meta__scorecards]] invariant). Omitted on a quiet day with no activity and no coverage value yet (no fabricated numbers).

## Safety / invariants
- **Read the scorecard, never the raw tables** — the watch line + the page read [[../tables/platform_scorecard_snapshots]] only ([[meta__scorecards]] invariant); the engine is the only writer.
- **Display-only proxy** ([[../operational-rules]] § North star) — every KPI is derived + read-only, never written back as a target the worker optimizes.
- **No fabricated numbers** — a quiet day with no daily activity AND no coverage snapshot omits the regression line (same "no data yet" invariant as the scorecard page).

## Completion criteria
- `regressions` row exists in `platform_scorecard_snapshots` daily with `detail.{detected, fixed, reconciled, escalated}`, and `regression_coverage_pct` exists in the weekly snapshot — both wired into the registries + the display config.
- `/dashboard/agents/scorecard` renders a "Regressions today" tile in the daily section and a "Re-verification coverage" tile in the weekly section.
- The Platform director's daily board-watch post carries the `Regressions: …` line (or omits it on a quiet day with no snapshot).
- `npx tsc --noEmit` is clean.

## Verification
- **Types:** `npx tsc --noEmit` is clean.
- **Daily metric lands.** Force-compute the daily scorecard (a throwaway `scripts/_probe.ts` calling `computePlatformScorecard(ws, { cadence:'daily', windowDays:1 })`) → `select value, detail from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='daily' and metric_key='regressions' and snapshot_date=current_date;` → exactly one row, `unit='count'`, `detail` carries integer `{detected, fixed, reconciled, escalated}` and `value` = their sum.
- **Weekly coverage lands.** Force-compute the weekly scorecard → `select value, detail from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='weekly' and metric_key='regression_coverage_pct';` → one row, `unit='pct'`, `value ∈ [0,100]`, `detail.shipped` = the live shipped-spec count, `detail.verified ≤ detail.shipped`, `detail.missing[]` lists the shipped slugs with no spec-test run in the trailing week.
- **Idempotent.** A same-day re-compute upserts in place — the count for these two metric rows is unchanged; `updated_at` bumps.
- **Page tiles render.** As the owner, open `/dashboard/agents/scorecard` → the daily section shows a "Regressions today" tile and the weekly section shows a "Re-verification coverage" tile. Each tile has a value, an arrow off `delta_pct` (up_is_good polarity), and a sparkline. No upstream snapshot for either → muted "no data yet", never a fabricated number.
- **Board-watch line is present + correct.** With Platform live+autonomous, on a day with at least one `detected_regression`/`authored_fix`/`reconciled_regression`/regression-`escalated` activity row OR a non-null weekly `regression_coverage_pct`, the next `postPlatformWatchUpdate` posts a [[../tables/director_messages]] update whose body contains `Regressions: N detected · N fixed · N reconciled · N escalated · XX% coverage`. The numbers match the daily `regressions.detail` and the weekly `regression_coverage_pct.value`.
- **Quiet-day omission.** With no regression activity for the day AND no weekly `regression_coverage_pct` snapshot, `composeRegressionWatchLine(snapshots)` returns `null` and the watch post body has NO `Regressions:` segment (and `metadata.regression_line` is `null`) — no fabricated numbers.
- **Reads only the scorecard.** The watch composer never queries `director_activity` / `spec_test_runs` directly; it reads only [[../tables/platform_scorecard_snapshots]] via `loadLatestScorecardSnapshots` (the [[meta__scorecards]] invariant). Grep for `composeRegressionWatchLine` in `src/lib/agents/platform-scorecard-display.ts` — it touches only `ScorecardSnapshotLite.detail / value / delta_pct / unit`.
