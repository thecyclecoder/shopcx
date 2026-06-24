# Scorecard monthly leading curve ⏳

**Priority:** critical

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/platform-department-scorecard]] — (c) Monthly leading curve
**Blocked-by:** [[platform-scorecard-engine]], [[deploy-health-rollback-guardian]]

Milestone (c) of the [[../goals/platform-department-scorecard|Platform Department Scorecard]]: the **monthly leading curve** — the slow-moving indicators that prove autonomy is compounding. This is where the goal's headline success metric lives: **human-touch-per-build declines month over month**. It **reuses the [[platform-scorecard-engine]] engine** and adds only the monthly KPI definitions, persisted as `cadence='monthly'` rows with prior-month deltas. Two of its KPIs depend on upstream outputs: **CI/deploy reliability** reads the deploy verdicts that **[[deploy-health-rollback-guardian]]** (⏳) writes to [[../tables/director_activity]] (`deploy_healthy｜deploy_rolled_back` — that spec explicitly writes those rows "so it shows in the board-watch + the KPI scorecard"), hence the **Blocked-by**; the **CEO's grade of the director's calls** reads [[../tables/director_decision_grades]], already populated because [[director-loop-grading]] is shipped (✅) — so no blocker is needed for it.

## Phase 1 — the monthly KPI registry
- ⏳ planned
- Extend the `computePlatformScorecard` KPI registry in `src/lib/agents/platform-scorecard.ts` (from [[platform-scorecard-engine]]) with the **monthly** metric set, reusing the engine's window/delta/upsert.
- **Monthly metric derivations**:
  - `human_touch_per_build` — the goal's headline. `(decisions where decided_by ∈ ceo｜human in the month) ÷ (kind='build' status='merged' in the month)` from [[../tables/approval_decisions]] × [[../tables/agent_jobs]]. Lower is better; the prior-month `delta_pct` is the "declining MoM" signal. `detail` carries the numerator/denominator.
  - `goals_escorted_unbabysat` — goals whose milestones advanced **without** CEO touch: [[../tables/director_activity]] `action_kind='escorted_goal'` (the Platform director's escort rows) cross-checked against [[../libraries/brain-roadmap]] shipped milestones (`getGoals()[].milestones`), counting only those with **no** non-autonomous [[../tables/approval_decisions]] (`decided_by ∈ ceo｜human`) on the goal in the month. `detail` lists the goals + milestones.
  - `time_to_approve_hours` — median over the month of `(approval_decisions.created_at − request_raised_at)`, where `request_raised_at` is the raising [[../tables/agent_jobs]] row's transition into `needs_approval` (approximated by the job's `updated_at` at emit / the `pending_action` timestamp). `detail` carries p50/p90. The "mean time-to-approve down" metric from [[../goals/devops-director]].
  - `deploy_reliability` — from the [[deploy-health-rollback-guardian]] verdicts: [[../tables/director_activity]] `action_kind='deploy_healthy'` ÷ (`deploy_healthy` + `deploy_rolled_back`) in the month. **This data does not exist until that guardian ships** — hence the Blocked-by. `detail` lists any rollback. (CI-green is folded in as the `build_success_rate` already computed by [[platform-scorecard-weekly]]; deploy reliability is the new, guardian-sourced half.)
  - `director_call_grade` — the CEO's grade of the Platform director's calls: average [[../tables/director_decision_grades]] `grade` over the month, split by `dimension ∈ auto-approval｜goal-escort` (the shape [[../libraries/director-leash-recommendations]] `computeDirectorGradeReport` already reads). `value` = the blended mean; `detail` = per-dimension means + count. Populated by [[director-loop-grading]] (✅).

## Phase 2 — the monthly snapshot beat
- ⏳ planned
- Add the monthly call to the [[../inngest/platform-director-cron]] `snapshot-platform-scorecard` step: once per **calendar month** per workspace, call `computePlatformScorecard(ws, { cadence:'monthly', windowDays:30 })`. Idempotent on `(metric_key, cadence='monthly', snapshot_date)`.
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
- Run the monthly compute for a workspace → `select metric_key, value, prior_value, delta_pct from platform_scorecard_snapshots where cadence='monthly' and snapshot_date=<this month>;` → one row per monthly KPI (`human_touch_per_build｜goals_escorted_unbabysat｜time_to_approve_hours｜deploy_reliability｜director_call_grade`).
- Spot-check `human_touch_per_build`: `select count(*) from approval_decisions where decided_by in ('ceo','human') and created_at >= <month start>;` ÷ `select count(*) from agent_jobs where kind='build' and status='merged' and updated_at >= <month start>;` = `value`.
- With no deploy verdicts yet (guardian not shipped), `deploy_reliability` is absent / null in `detail` (not a fabricated 100%).
- `select detail from platform_scorecard_snapshots where metric_key='director_call_grade' and cadence='monthly' …` → per-`dimension` means matching `computeDirectorGradeReport`.
- Re-run the same month → row count unchanged (idempotent).
