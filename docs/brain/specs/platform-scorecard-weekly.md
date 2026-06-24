# Scorecard weekly throughput + quality rollup ✅

**Priority:** critical

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/platform-department-scorecard]] — (b) Weekly throughput + quality
**Blocked-by:** [[platform-scorecard-engine]]

Milestone (b) of the [[../goals/platform-department-scorecard|Platform Department Scorecard]]: the **weekly** lens — how much the build org shipped this week and how good it was. The data exists but is never rolled into a department card: [[../tables/agent_action_grades]] (+ [[../libraries/agent-grader]] `computeAgentRollup`) holds per-worker grades but only ever feeds the coaching trigger; build success rate + idea→merge cycle time are derivable from [[../tables/agent_jobs]] but unaggregated and untrended. This spec **reuses the [[platform-scorecard-engine]] engine** (window/delta/snapshot machinery + `platform_scorecard_snapshots`) and adds **only the weekly KPI definitions**, persisted as `cadence='weekly'` rows with prior-week deltas — so the CEO reads specs/week, build success, cycle time, % approvals never touched, per-worker grades, and regressions caught with zero hand-counting (the goal's success metric).

## Phase 1 — the weekly KPI registry
- ✅ shipped — `src/lib/agents/platform-scorecard.ts`: the six weekly `MetricDef`s + `WEEKLY_METRICS` wired into `REGISTRY.weekly` (reuses the engine's window/delta/upsert); `libraries/platform-scorecard.md` brain page gains the weekly registry table.
- Extend the `computePlatformScorecard` KPI registry in `src/lib/agents/platform-scorecard.ts` (from [[platform-scorecard-engine]]) with the **weekly** metric set. Each metric reuses the engine's trailing-window + prior-window-delta + idempotent upsert; only the derivation is new.
- **Weekly metric derivations** (all from existing truth):
  - `specs_per_week` — [[../tables/agent_jobs]] `kind='build'` + `status='merged'` with `updated_at` in the 7-day window, `spec_slug` mapped to **platform** via the live spec→owner map ([[../libraries/brain-roadmap]] `getRoadmap().specs[].owner`, the exact rule [[../libraries/director-xp]] uses).
  - `build_success_rate` — `merged ÷ (merged + failed)` over the window from [[../tables/agent_jobs]] (`status='merged'` vs `status='failed'｜'needs_attention'`), `kind='build'`. `detail` carries the raw counts.
  - `idea_to_merge_hours` — median over merged builds of `(updated_at − created_at)` (queued → merged), the "idea→merged-PR" north-star metric from [[../functions/platform]]. `detail` carries p50/p90.
  - `approvals_untouched_pct` — [[../tables/approval_decisions]] `autonomous=true` ÷ all terminal decisions over the week (the "% of platform approvals you never have to touch" metric from [[../goals/devops-director]]; `decided_by ∈ ceo｜human` = a touched approval).
  - `worker_grade_rollup` — per `agent_kind` average from [[../tables/agent_action_grades]] via [[../libraries/agent-grader]] `computeAgentRollup` (the window/last-10 rollup it already exposes). `value` = the fleet mean; `detail` = the per-worker breakdown (`build`/`repair`/`db_health`/… each with its mean + trend) so a slipping worker is visible.
  - `regressions_caught` — [[../tables/agent_jobs]] `kind='regression'` concluded in-window **+** [[../tables/director_activity]] rows with `action_kind ∈ detected_regression｜authored_fix` (the open vocabulary the [[../specs/regression-agent|Regression Agent]] already emits). `detail` splits detected vs dismissed vs fix-authored.

## Phase 2 — the weekly snapshot beat
- ✅ shipped — `src/lib/inngest/platform-director-cron.ts`: the `snapshot-platform-scorecard-weekly` step (once-per-ISO-week guard on any weekly row ≥ the ISO-week Monday) calls `computePlatformScorecard(ws, { cadence:'weekly', windowDays:7 })`; `inngest/platform-director-cron.md` brain page updated.
- Add the weekly call to the [[../inngest/platform-director-cron]] `snapshot-platform-scorecard` step (added in [[platform-scorecard-engine]] Phase 3): once per **ISO week** per workspace, call `computePlatformScorecard(ws, { cadence:'weekly', windowDays:7 })`. The idempotent upsert on `(metric_key, cadence='weekly', snapshot_date)` makes a same-week re-run a no-op.
- Update the [[../inngest/platform-director-cron]] brain page with the weekly snapshot.

## Safety / invariants
- **Display-only proxy, never an objective** ([[../operational-rules]] § North star) — same invariant as [[platform-scorecard-engine]]: grades + rates are read-only, persisted for trend, never written back as a target. A per-worker grade surfaced here is the *same* number the coaching loop reads; the scorecard never becomes a second source of truth.
- **One engine, one writer** — these are new entries in the existing registry, not a parallel computation. No second copy of the window/delta logic.
- **Idempotent** per `(metric_key, cadence='weekly', snapshot_date)`.

## Completion criteria
- `computePlatformScorecard` computes the six weekly KPIs and upserts `cadence='weekly'` rows with `prior_value` + `delta_pct`; `npx tsc --noEmit` clean.
- The weekly snapshot runs on the `platform-director-cron` beat once per ISO week per build-console workspace.
- `worker_grade_rollup.detail` carries the per-`agent_kind` breakdown from `computeAgentRollup`.

## Verification
- **Types:** `npx tsc --noEmit` is clean.
- **Compute once for a workspace** (a throwaway `scripts/_probe.ts` calling `computePlatformScorecard(ws, { cadence:'weekly', windowDays:7 })`) → `select metric_key, value, prior_value, delta_pct, unit from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='weekly' and snapshot_date=current_date order by metric_key;` → exactly six rows, one per weekly KPI (`approvals_untouched_pct｜build_success_rate｜idea_to_merge_hours｜regressions_caught｜specs_per_week｜worker_grade_rollup`), units `pct｜ratio｜hours｜count｜count｜ratio`.
- **Per-worker rollup breakdown:** `select detail from platform_scorecard_snapshots where metric_key='worker_grade_rollup' and cadence='weekly' and workspace_id='<ws>' and snapshot_date=current_date;` → `detail.by_worker` has one entry per graded `agent_kind` (`average`/`prior`/`drop`/`count`), and `value` = the mean of those non-null averages — cross-check against `computeAgentRollup(admin, ws, kind)` for each kind.
- **Idempotent re-run** the same week → `select count(*) from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='weekly' and snapshot_date=current_date;` is unchanged at 6 (upsert in place); `updated_at` bumps.
- **Spot-check `build_success_rate`** against `select status, count(*) from agent_jobs where workspace_id='<ws>' and kind='build' and updated_at >= <week start> group by 1;` → `value` = merged ÷ (merged + failed‖needs_attention); `detail` carries the raw `merged`/`failed`/`total`.
- **Spot-check `specs_per_week`** → `detail.slugs` are all platform-owned specs (`getRoadmap().specs[].owner === 'platform'`); non-platform merged builds in the same window are excluded.
- **`approvals_untouched_pct` is a percentage** (0–100): `value` = `autonomous=true ÷ (approved+declined)` × 100; `detail.touched` counts the `decided_by ∈ ceo｜human` decisions.
- **After a `platform-director-cron` tick** (Inngest run history) → the `snapshot-platform-scorecard-weekly` step shows `produced.scorecardWeekly.metricsWritten > 0` (or `snapshotted=0` if already done this ISO week) with no error; the rows above exist. A second tick the same ISO week is a no-op (guard skips already-snapshotted workspaces).
