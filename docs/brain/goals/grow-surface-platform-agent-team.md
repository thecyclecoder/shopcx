# Grow & Surface the Platform Agent Team

**Owner:** [[../functions/platform]]
**Status:** proposed

**Outcome:** A complete, fully-visible DevOps agent roster: every running agent shows on the org view (no hidden agents), and the gaps that the auto-merge autonomy opened are filled — deploy rollback, security, and cost governance.

**Why now:** tonight we found the documented roster (11), the persona cast, and the actually-running lanes (15) have drifted apart — agents like Sol, Sage, and Dex run but aren't on the team view, and Remi is listed but never fires. And auto-merging fixes (so you never handle errors) opened real safety gaps: no post-deploy rollback, no autonomous security review, no spend governance.

**Success metric:** the org view reflects 100% of running agents (reconciled to [[../tables/agent_jobs]] + personas, kept in sync); every auto-merged deploy is health-watched + auto-rolled-back on a correlated regression; every merged diff gets an autonomous security pass; fleet spend is budgeted + visible on the scorecard.

**Target:** decompose + sequence via the [[../specs/goal-decomposition-engine|goal decomposition engine]] (human-gated) into the milestone specs below, or author them in order. This doc is the seed + the design contract.

## Milestone seeds for Pia

- **M1 — Roster sync:** surface EVERY running agent on the org/team view, reconcile the brain roster + personas + live [[../tables/agent_jobs]] lanes, flag inactive ones (e.g. Remi), and keep them in sync. *(Known gap found 2026-06-24: the team roster reads only `agent-kind` MONITORED_LOOPS, so personified platform crons — Tao/monitor, Devi/db_health, Cole/coverage-register — are invisible; the `control-tower-monitor` loop has no `agentKind`. M1 reconciles loops + personas + live lanes as one source.)*
- **M2 — Deploy-Health / Auto-Rollback guardian** ([[../specs/deploy-health-rollback-guardian]], already greenlit).
- **M3 — Security / Dependency agent** — per-diff review + CVE / dep-upgrade watch.
- **M4 — Cost / Spend governor** — budgets + per-spec cost (surfaces on [[platform-department-scorecard]]).

Owner: [[../functions/platform]] (the boss, Ada). Reports to: [[ceo-mode]]. Pairs with [[platform-department-scorecard]] (M4 spend surfaces there).

## Decomposition

Specs authored by the [[../specs/goal-decomposition-engine|goal-decomposition engine]] (owner-approved). Each is owner+parent tagged; `Blocked-by` encodes build order so only unblocked specs queue immediately and dependents auto-queue as their blockers ship.

### M1 — Roster sync
- [[../specs/agent-roster-sync]] ✅ — reconcile MONITORED_LOOPS (cron + agent-kind) ↔ PERSONAS ↔ live agent_jobs into one roster so the org view surfaces 100% of running agents (incl. Tao/Devi/Cole + control-tower-monitor) and flags inactive ones (Remi).

### M2 — Deploy-Health / Auto-Rollback guardian
- [[../specs/deploy-health-rollback-guardian]] ⏳ — already greenlit: watch each auto-merged deploy over a canary window and auto-rollback on a correlated regression.

### M3 — Security / Dependency agent
- [[../specs/security-dependency-agent]] ⏳ — a new agent-kind lane + persona giving every merged `claude/*` diff an autonomous read-only security pass + a scheduled CVE/dependency-upgrade watch (owner-gated fixes, never auto-mutating).

### M4 — Cost / Spend governor
- [[../specs/fleet-cost-metering]] ⏳ — capture per-job fleet spend nothing meters today (claude -p stream tokens + Max usage-window), keyed spec→kind→function; the metric foundation.
- [[../specs/fleet-spend-governor]] ⏳ — *(blocked by [[../specs/fleet-cost-metering]])* set per-kind/function budgets, escalate (never silently cap) on overrun, surface a fleet-spend line + feed the [[platform-department-scorecard]] KPI.
