# inngest/fleet-spend-governor

The Phase-2 SUPERVISOR pass on the metered-cost proxy ([[../libraries/fleet-cost]]). Every ~30 min, per build-console workspace, it reads each effective [[../tables/fleet_budgets]] row against the [[../libraries/fleet-cost]] rollup; on a lane (`kind`) or function (`owner_function`) OVER its ceiling, it ESCALATES via [[../libraries/approval-router]] `resolveApproverLive("platform")` (a live+autonomous director, else the CEO inbox) and writes one [[../tables/director_activity]] row (`director_function='platform'`, `action_kind='budget_breach'`). Loop-guarded — one OPEN breach notification per lane at a time; the next sweep re-surfaces it after dismissal if the breach persists (mirrors the [[../libraries/control-tower]] dedup-while-red pattern). NEVER auto-throttles or pauses a lane ([[../operational-rules]] § North star).

**File:** `src/lib/inngest/fleet-spend-governor.ts` · logic in [[../libraries/fleet-spend-governor]] (`runFleetSpendGovernor`)

## Functions

### `fleet-spend-governor`
- **Trigger:** cron `10,40 * * * *` (every ~30 min, offset from the :00/:15 crons)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** for each build-console workspace (any with an [[../tables/agent_jobs]] row — matches `spec-drift-reconcile` / `platform-director-cron`) calls `runFleetSpendGovernor({ workspaceId })`. The runner builds the most-specific [[../tables/fleet_budgets]] row per (scope, key) (workspace override beats global default), rolls up [[../libraries/fleet-cost]] over each distinct `window_days`, and for every effective budget compares the matching bucket's `total_tokens` against `token_ceiling` and (where API-billed) `usd_cents` against `usd_ceiling_cents`. Each breach is escalated through `escalateBudgetBreach` to the resolved approver's inbox (`metadata.routed_to_function`), deduped on `metadata.dedupe_key = fleet_budget_breach:<scope>:<key>` against an OPEN (undismissed) [[../tables/dashboard_notifications]] row.
- **Loop-guard:** while a breach notification is open (`dismissed=false`), the next sweep BUMPS its title/body/metadata only (no new row, no new [[../tables/director_activity]] entry, no re-page). Once the operator dismisses it, a still-over budget re-surfaces a fresh notification + a new `budget_breach` activity row.
- **Self-monitoring:** emits its own `fleet-spend-governor` heartbeat at the end (`emitCronHeartbeat`), registered in `src/lib/control-tower/registry.ts` (`livenessWindowMs` 90m) so a dead governor shows as a stale cron tile.
- **Returns** `{ workspaces, evaluated, breaches, escalations, reSurfaced, routedTo }`.

## North-star invariant

A budget is a **surfaced guardrail**, never a kill-switch. The governor is the autonomous TOOL on the metered-cost proxy ([[../libraries/fleet-cost]]); when it hits its rail (a lane over ceiling), it ESCALATES UP to its supervisor (a live+autonomous platform director, else the CEO) — it never throttles, parks, or pauses a lane (see [[../operational-rules]] § North star + [[../specs/fleet-spend-governor]] Phase 2).

## Downstream events sent

_None._ Side effects are a [[../tables/dashboard_notifications]] insert/update (`type='agent_approval_request'`, `metadata.escalation_kind='fleet_budget_breach'`) + a [[../tables/director_activity]] insert.

## Tables written

- [[../tables/dashboard_notifications]] (one OPEN breach notification per lane; bumped on re-surface)
- [[../tables/director_activity]] (`action_kind='budget_breach'`, one per emitted escalation)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/fleet_budgets]] (effective ceilings — defaults UNION workspace overrides)
- [[../tables/agent_job_costs]] + [[../tables/ai_token_usage]] (via [[../libraries/fleet-cost]] `rollupFleetCost`)
- [[../tables/agent_jobs]] (build-console workspace discovery)
- [[../tables/function_autonomy]] (via [[../libraries/approval-router]] `resolveApproverLive`)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `platform` (`livenessWindowMs` 90m) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../specs/fleet-spend-governor]] · [[../libraries/fleet-spend-governor]] · [[../libraries/fleet-cost]] · [[../tables/fleet_budgets]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[../libraries/approval-router]] · [[../libraries/control-tower]] · [[../operational-rules]] (§ North star)
