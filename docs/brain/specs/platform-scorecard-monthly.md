# Scorecard monthly leading curve ✅

**Priority:** critical

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/platform-department-scorecard]] — (c) Monthly leading curve
**Blocked-by:** [[platform-scorecard-engine]], [[deploy-health-rollback-guardian]]

Milestone (c) of the [[../goals/platform-department-scorecard|Platform Department Scorecard]]: the **monthly leading curve** — the slow-moving indicators that prove autonomy is compounding. This is where the goal's headline success metric lives: **human-touch-per-build declines month over month**. It **reuses the [[platform-scorecard-engine]] engine** and adds only the monthly KPI definitions, persisted as `cadence='monthly'` rows with prior-month deltas. Two of its KPIs depend on upstream outputs: **CI/deploy reliability** reads the deploy verdicts that **[[deploy-health-rollback-guardian]]** (⏳) writes to [[../tables/director_activity]] (`deploy_healthy｜deploy_rolled_back` — that spec explicitly writes those rows "so it shows in the board-watch + the KPI scorecard"), hence the **Blocked-by**; the **CEO's grade of the director's calls** reads [[../tables/director_decision_grades]], already populated because [[director-loop-grading]] is shipped (✅) — so no blocker is needed for it.

## Phase 1 — the monthly KPI registry
- ✅ shipped — `src/lib/agents/platform-scorecard.ts` `MONTHLY_METRICS` registry (5 KPIs) + `REGISTRY.monthly`; `compute` may now return `null` to SKIP a row (deploy_reliability honesty); brain page `libraries/platform-scorecard.md`.
- Extend the `computePlatformScorecard` KPI registry in `src/lib/agents/platform-scorecard.ts` (from [[platform-scorecard-engine]]) with the **monthly** metric set, reusing the engine's window/delta/upsert.
- **Monthly metric derivations**:
  - `human_touch_per_build` — the goal's headline. `(decisions where decided_by ∈ ceo｜human in the month) ÷ (kind='build' status='merged' in the month)` from [[../tables/approval_decisions]] × [[../tables/agent_jobs]]. Lower is better; the prior-month `delta_pct` is the "declining MoM" signal. `detail` carries the numerator/denominator.
  - `goals_escorted_unbabysat` — goals whose milestones advanced **without** CEO touch: [[../tables/director_activity]] `action_kind='escorted_goal'` (the Platform director's escort rows) cross-checked against [[../libraries/brain-roadmap]] shipped milestones (`getGoals()[].milestones`), counting only those with **no** non-autonomous [[../tables/approval_decisions]] (`decided_by ∈ ceo｜human`) on the goal in the month. `detail` lists the goals + milestones.
  - `time_to_approve_hours` — median over the month of `(approval_decisions.created_at − request_raised_at)`, where `request_raised_at` is the raising [[../tables/agent_jobs]] row's transition into `needs_approval` (approximated by the job's `updated_at` at emit / the `pending_action` timestamp). `detail` carries p50/p90. The "mean time-to-approve down" metric from [[../goals/devops-director]].
  - `deploy_reliability` — from the [[deploy-health-rollback-guardian]] verdicts: [[../tables/director_activity]] `action_kind='deploy_healthy'` ÷ (`deploy_healthy` + `deploy_rolled_back`) in the month. **This data does not exist until that guardian ships** — hence the Blocked-by. `detail` lists any rollback. (CI-green is folded in as the `build_success_rate` already computed by [[platform-scorecard-weekly]]; deploy reliability is the new, guardian-sourced half.)
  - `director_call_grade` — the CEO's grade of the Platform director's calls: average [[../tables/director_decision_grades]] `grade` over the month, split by `dimension ∈ auto-approval｜goal-escort` (the shape [[../libraries/director-leash-recommendations]] `computeDirectorGradeReport` already reads). `value` = the blended mean; `detail` = per-dimension means + count. Populated by [[director-loop-grading]] (✅).

## Phase 2 — the monthly snapshot beat
- ✅ shipped — new `snapshot-platform-scorecard-monthly` step in [[../inngest/platform-director-cron]] (`src/lib/inngest/platform-director-cron.ts`); brain page updated.
- Add the monthly call to the [[../inngest/platform-director-cron]] (`snapshot-platform-scorecard-monthly` step): once per **calendar month** per workspace, call `computePlatformScorecard(ws, { cadence:'monthly', windowDays:30 })`. Idempotent on `(metric_key, cadence='monthly', snapshot_date)`; the once-per-month guard skips a workspace that already has a `cadence='monthly'` row dated this month.
- Update the [[../inngest/platform-director-cron]] brain page.

## Safety / invariants
- **Display-only proxy, never an objective** ([[../operational-rules]] § North star) — `human_touch_per_build` and `director_call_grade` are **measured, never targeted**: the directors must not learn to suppress escalations to game the curve. Read-only, persisted for trend, never written back.
- **Honest about missing upstream data** — `deploy_reliability` is null/absent (not a fake 100%) until [[deploy-health-rollback-guardian]] writes its first verdict; the metric surfaces "no data yet" rather than implying perfect reliability. The Blocked-by enforces build order so the KPI is never wired against a non-existent source.
- **Idempotent** per `(metric_key, cadence='monthly', snapshot_date)`.

## Completion criteria
- `computePlatformScorecard` computes the five monthly KPIs and upserts `cadence='monthly'` rows with `prior_value` + `delta_pct`; `npx tsc --noEmit` clean.
- The monthly snapshot runs on the `platform-director-cron` beat once per calendar month per build-console workspace.
- `human_touch_per_build` trends month-over-month (prior-month delta populated); `deploy_reliability` reads real [[deploy-health-rollback-guardian]] verdicts; `director_call_grade` reads [[../tables/director_decision_grades]].

## Verification
- In a deployed runtime, run `computePlatformScorecard(<ws>, { cadence:'monthly', windowDays:30 })` (or wait for the `platform-director-cron` monthly beat) → `select metric_key, value, prior_value, delta_pct, unit from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='monthly' and snapshot_date >= date_trunc('month', now());` → expect up to 5 rows, one per monthly KPI present (`human_touch_per_build｜goals_escorted_unbabysat｜time_to_approve_hours｜deploy_reliability｜director_call_grade`) — `deploy_reliability` is **absent** when no verdicts exist (see below).
- Spot-check `human_touch_per_build`: `select count(*) from approval_decisions where workspace_id='<ws>' and decided_by in ('ceo','human') and created_at >= date_trunc('month', now());` ÷ `select count(*) from agent_jobs where workspace_id='<ws>' and kind='build' and status='merged' and updated_at >= date_trunc('month', now());` → equals the row's `value` (rounded to 4dp); `detail` carries `touches`/`builds`. Builds=0 → `value`=0.
- With **no** deploy verdicts in-window (`select count(*) from director_activity where action_kind in ('deploy_healthy','deploy_rolled_back') and director_function='platform' and created_at >= date_trunc('month', now());` = 0) → expect **no** `deploy_reliability` row at all (not a fabricated `1.0`/`100%`). Once a verdict exists → expect `value = deploy_healthy ÷ (deploy_healthy + deploy_rolled_back)`.
- `select detail from platform_scorecard_snapshots where workspace_id='<ws>' and metric_key='director_call_grade' and cadence='monthly' and snapshot_date >= date_trunc('month', now());` → `detail.by_dimension` carries per-`dimension` (`auto-approval`/`goal-escort`) means + counts matching `director_decision_grades` over the month (the shape `computeDirectorGradeReport` reads); `value` = the blended mean (1–10, `detail.scale='1-10'`).
- `time_to_approve_hours`: `detail` carries `p50`/`p90`/`sample`/`excluded` + an `approximation` note (`request_raised_at ≈ raising agent_jobs.updated_at`); non-positive deltas are in `excluded`, not `sample`.
- `goals_escorted_unbabysat`: `detail.goals` lists each counted goal + its shipped milestones; a goal with a CEO/human approval on one of its specs in-month appears in `detail.babysat` and is **not** counted.
- Re-run the same calendar month (or let the cron fire again same month) → the once-per-month guard skips the workspace, and the `(workspace_id, metric_key, cadence='monthly', snapshot_date)` upsert keeps the row count unchanged (idempotent).
