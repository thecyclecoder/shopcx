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

Owner: [[../functions/platform]] (the boss, Ada). Reports to: [[ceo-mode]]. Mirrors the grading/recap substrate from [[devops-director]].
