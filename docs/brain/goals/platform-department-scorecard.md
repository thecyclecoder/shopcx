# Platform Department Scorecard

**Owner:** [[../functions/platform]]
**Status:** proposed

**Outcome:** A live daily/weekly/monthly scorecard of the Platform/DevOps department so the CEO sees how the build org is doing — autonomy curve, throughput, reliability, decision quality — with zero hand-counting.

**Why now:** the data already exists ([[../tables/director_activity]], [[../tables/agent_jobs]], [[../tables/error_events]], [[../tables/loop_alerts]], the grade tables); we just don't aggregate it. We're scaling autonomy fast and need the instrument panel to prove it's working and catch a slipping agent early.

**Success metric:** every KPI live + trending, no hand-counting; human-touch-per-build declines month over month; escalations-to-CEO stay low and on-target.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated) into the milestone specs below, or author them in order. This doc is the seed + the design contract.

## Milestone seeds for Pia

- **(a) Daily pulse** — loop health, open-error backlog + MTTR, build throughput, autonomy ratio, escalations.
- **(b) Weekly throughput + quality** — specs/week, build success rate, idea→merge cycle time, % approvals you never touched, per-worker grade rollups, regressions caught.
- **(c) Monthly leading curve** — human-touch/build, goals escorted unbabysat, time-to-approve, CI/deploy reliability, your grade of my calls.
- **(d) Surfacing** — a scorecard page + a board-watch line.

## Decomposition

Self-sequencing via `blocked_by` — only the unblocked foundation builds immediately; dependents auto-queue as their blockers ship ([[../specs/spec-blockers]]).

- **(a) Daily pulse** — [[../specs/platform-scorecard-engine]] ⏳ — the shared KPI aggregation engine (`src/lib/agents/platform-scorecard.ts`) + the new `platform_scorecard_snapshots` trend store + a daily snapshot step on [[../inngest/platform-director-cron]]: loop health, error backlog + derived MTTR, build throughput, autonomy ratio, escalations. *(foundation — blocked_by [])*
- **(b) Weekly throughput + quality** — [[../specs/platform-scorecard-weekly]] ⏳ — adds the weekly KPI registry: specs/week, build success rate, idea→merge cycle time, % approvals never touched, per-worker grade rollups ([[../tables/agent_action_grades]]), regressions caught. *(blocked by [[../specs/platform-scorecard-engine]])*
- **(c) Monthly leading curve** — [[../specs/platform-scorecard-monthly]] ⏳ — adds the monthly KPIs: human-touch/build (the headline, trending down MoM), goals escorted unbabysat, time-to-approve, CI/deploy reliability (from [[../specs/deploy-health-rollback-guardian]] verdicts), CEO grade of director calls ([[../tables/director_decision_grades]]). *(blocked by [[../specs/platform-scorecard-engine]], [[../specs/deploy-health-rollback-guardian]])*
- **(d) Surfacing** — [[../specs/platform-scorecard-surface]] ⏳ — the owner-gated `/dashboard/agents/scorecard` page (`GET /api/developer/agents/scorecard` over the snapshot store) with daily/weekly/monthly KPI tiles + trend arrows, plus the one-line #directors board-watch post + Daily Summaries deep-link. Reserves a fleet-spend tile for the [[../goals/grow-surface-platform-agent-team|grow-surface]] cost governor. *(blocked by [[../specs/platform-scorecard-engine]], [[../specs/platform-scorecard-weekly]], [[../specs/platform-scorecard-monthly]])*

Owner: [[../functions/platform]] (the boss, Ada). Reports to: [[ceo-mode]]. Mirrors the grading/recap substrate from [[devops-director]].
