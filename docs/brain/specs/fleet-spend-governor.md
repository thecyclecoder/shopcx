# Fleet Spend Governor ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/grow-surface-platform-agent-team]] · M4 — Cost / Spend governor
**Blocked-by:** [[fleet-cost-metering]]

The goal's success metric requires "fleet spend is **budgeted + visible** on the scorecard." [[fleet-cost-metering]] makes spend measurable (per `spec_slug` / `kind` / `owner_function`); this spec is the **supervisor on that proxy** — it sets budgets, tracks spend-to-budget, and **escalates** (never silently caps) when a lane trends over, then surfaces a fleet-spend line for the CEO. It is **blocked by** [[fleet-cost-metering]] because budgets are meaningless without the metered cost data, and [[../tables/agent_jobs]] has no cost column until that spec ships.

## North star — escalate at the rail, never silently cap
Per the supervisable-autonomy north star ([[../operational-rules]] § North star), an autonomous tool that hits a guardrail **escalates, it does not execute around it**. Spend is the bounded proxy; the objective (a healthy, affordable fleet) is the director's. So this governor never auto-throttles or kills a lane behind the owner's back — an over-budget trend routes **up** the org chart to the supervisor, who decides. Budgets are surfaced guardrails, not silent kill-switches.

## Phase 1 — budgets ⏳
- ⏳ planned
- A budget config — a new `fleet_budgets` table (or a config block) — keyed per `agent_jobs.kind` and/or per `owner_function`, expressing a ceiling in the [[fleet-cost-metering]] units (token / usage-window per day or week, plus `$` where API-billed). Sensible defaults seeded; owner-editable.
- Brain: new `tables/fleet_budgets` + `libraries/fleet-spend-governor`.

### Verification — Phase 1
- A `fleet_budgets` row exists per active lane/function with a default ceiling; editing one persists and reads back.

## Phase 2 — track spend-to-budget + escalate on overrun ⏳
- ⏳ planned
- A scheduled check (`inngest/fleet-spend-governor`, a `MONITORED_LOOPS` `cron` tile owned by `platform` with a `registeredAt`) reads the [[fleet-cost-metering]] rollup vs `fleet_budgets`. On a lane/function **trending over** its ceiling, route via [[../libraries/approval-router]] `resolveApproverLive("platform")` (a live+autonomous director, else the CEO inbox) and write a [[../tables/director_activity]] row (`director_function: 'platform'`, `action_kind` e.g. `budget_breach` / `escalated`, `reason` = which lane, how far over). **Never** auto-throttles or pauses a lane.
- Loop-guard the escalation (one open breach per lane at a time, re-surface on persistence) so a sustained overrun doesn't spam the inbox — mirror the [[../libraries/control-tower]] dedup-while-red pattern.

### Verification — Phase 2
- A lane seeded over its budget → exactly one escalation to the platform approver + a `budget_breach` `director_activity` row, and the lane keeps running (not capped). A lane under budget → no escalation, a healthy beat.

## Phase 3 — surface the fleet-spend line ⏳
- ⏳ planned
- Surface a **fleet-spend line** on the [[../dashboard/control-tower]] / board-watch (spend-to-budget per kind / function, breaches highlighted) — the "visible" half of the success metric.
- Feed the [[platform-department-scorecard]] spend KPI: expose the rollup + budget status in the shape that goal's surfacing milestone (its (d) scorecard page) reads, so spend lands on the scorecard when it ships (no cross-goal build dependency — this is a read contract, not a blocker).

### Verification — Phase 3
- On `/dashboard/developer/control-tower`, the fleet-spend line shows each lane's spend-to-budget with breaches highlighted; the rollup is queryable in the scorecard's shape.

## Safety / invariants
- **Escalate, never silently cap** — an over-budget trend routes up the org chart to the supervisor; the governor never auto-throttles, parks, or kills a lane on its own ([[../operational-rules]] § North star).
- Read-only over [[fleet-cost-metering]] — it consumes the metered rollup, it does not re-meter or mutate cost data.
- Escalations are deduped/loop-guarded (one open breach per lane) so a sustained overrun informs without spamming.
- Budgets are **guardrails surfaced to a human/director**, owner-editable — not hardcoded kill-switches.

## Completion criteria
- Per-kind / per-function fleet budgets exist and are owner-editable.
- An over-budget lane **escalates** (with a `director_activity` row) and keeps running — it is never silently capped.
- A fleet-spend line is visible on the Control Tower / board-watch, and the rollup is exposed in the [[platform-department-scorecard]] spend-KPI shape.

## Verification
- On `/dashboard/developer/control-tower`, view the fleet-spend line → expect spend-to-budget per kind/function with any breach highlighted.
- Seed a lane's metered spend above its `fleet_budgets` ceiling and run the governor cron → expect one escalation to the platform approver + a `budget_breach` `director_activity` row, and the lane still active (not paused).
- Query the governor's rollup in the scorecard shape → expect per-function spend + budget status ready for the [[platform-department-scorecard]] KPI.

## Related
[[fleet-cost-metering]] · [[../libraries/approval-router]] · [[../tables/director_activity]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]] · [[platform-department-scorecard]] · [[../operational-rules]] · [[../goals/grow-surface-platform-agent-team]]
