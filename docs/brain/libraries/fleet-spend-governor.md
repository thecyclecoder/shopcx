# libraries/fleet-spend-governor

Fleet spend governor — the SUPERVISOR surface on the metered-cost proxy ([[fleet-cost]]). Phase 1 = the **budget-config** side (read + upsert + delete [[../tables/fleet_budgets]] rows). Phase 2 (now shipped) = the **escalation** side (`runFleetSpendGovernor` — compares each effective budget against `rollupFleetCost()` and ESCALATES on overrun via [[approval-router]] + a [[../tables/director_activity]] row; never auto-throttles). Authored by [[../specs/fleet-spend-governor]] (M4 of [[../goals/grow-surface-platform-agent-team]]).

**File:** `src/lib/fleet-spend-governor.ts`

## File header

```
Fleet spend governor — the SUPERVISOR on the metered-cost proxy (fleet-cost).

Phase 1: the BUDGET-config side — read + upsert fleet_budgets rows.
Phase 2 (this file, added): runFleetSpendGovernor — reads each effective budget
against rollupFleetCost() and ESCALATES on overrun via approval-router (a live+
autonomous director, else the CEO inbox) + a director_activity row. Loop-guard
deduped on dashboard_notifications (one OPEN breach per lane at a time; the next
sweep re-surfaces it after the operator dismisses it but the breach persists).
NEVER auto-throttles or pauses a lane (operational-rules § North star). Phase 3
surfaces the spend-to-budget line.
```

## Exports

### `FleetBudget` — interface

The TS shape of a [[../tables/fleet_budgets]] row, with snake_case columns mapped to camelCase and `bigint` / `numeric` strings normalized to `number` (`tokenCeiling`, `usdCeilingCents`). `kind` and `ownerFunction` are mutually exclusive — exactly one is non-null per row (DB-enforced).

### `BudgetScope` — type

`"kind" | "owner_function"` — the scope axis a budget caps.

### `listFleetBudgets` — function

```ts
async function listFleetBudgets(workspaceId?: string | null): Promise<FleetBudget[]>
```

Every [[../tables/fleet_budgets]] row visible to the given workspace — the global defaults (`workspace_id IS NULL`) UNION the workspace's overrides. The Phase 2 governor picks the most-specific row (workspace override beats global default) per scope key.

### `getEffectiveBudget` — function

```ts
async function getEffectiveBudget(
  workspaceId: string | null,
  scope: BudgetScope,
  value: string,
): Promise<FleetBudget | null>
```

The EFFECTIVE budget for a `(workspace, scope, value)` tuple — the workspace-specific row if present, else the global default. Returns `null` when neither exists. This is the per-lane / per-function lookup the Phase 2 governor cron uses on every tick.

### `upsertFleetBudget` — function

```ts
async function upsertFleetBudget(p: UpsertBudgetParams): Promise<FleetBudget>
```

Owner-editable upsert. Supply exactly **one** of (`kind`, `ownerFunction`) — both / neither throw. Matches the partial unique indexes (`fleet_budgets_kind_uniq` / `fleet_budgets_function_uniq`) — implemented as SELECT + INSERT/UPDATE since PostgREST `upsert` doesn't support a partial unique target. Service-role only.

`UpsertBudgetParams`: `{ workspaceId?, kind?, ownerFunction?, windowDays?, tokenCeiling?, usdCeilingCents?, notes?, updatedBy? }`. `updatedBy` is the `auth.users.id` of the editor (best-effort attribution).

### `deleteFleetBudget` — function

```ts
async function deleteFleetBudget(id: string): Promise<boolean>
```

Delete one budget (an owner pruning a stale guardrail). Returns `true` on a delete, `false` when the row didn't exist.

### `runFleetSpendGovernor` — function (Phase 2)

```ts
async function runFleetSpendGovernor({ workspaceId }: { workspaceId: string }): Promise<FleetSpendGovernorResult>
```

The Phase-2 SUPERVISOR pass for one workspace. Builds the most-specific [[../tables/fleet_budgets]] row per (scope, key) (workspace override beats global default), rolls up [[fleet-cost]] over each distinct `window_days`, and detects breaches per axis (`total_tokens > token_ceiling` and/or, on API-billed buckets, `usd_cents > usd_ceiling_cents`). Each breach is escalated through the internal `escalateBudgetBreach` helper to the resolved approver's inbox (one [[../tables/dashboard_notifications]] row, `metadata.routed_to_function`) + a [[../tables/director_activity]] row (`director_function='platform'`, `action_kind='budget_breach'`). Loop-guarded — deduped on `metadata.dedupe_key = fleet_budget_breach:<scope>:<key>` against an OPEN (undismissed) notification; a still-open breach BUMPS the existing row's title/body/metadata and writes NO new activity entry. NEVER throttles or pauses a lane.

`FleetSpendGovernorResult`: `{ evaluated, breaches, escalations, reSurfaced, details: FleetBudgetBreach[] }`. `evaluated` = effective budgets checked; `breaches` = currently over; `escalations` = newly-emitted notifications; `reSurfaced` = already-open notifications bumped. `details` carries the per-breach `{ budget, bucket, tokenOver, usdOver, dedupeKey, reason }` for the cron heartbeat / verification.

### `resolveFleetSpendApprover` — function (Phase 2)

```ts
async function resolveFleetSpendApprover(): Promise<string>
```

Convenience wrapper around [[approval-router]] `resolveApproverLive("platform")` — returns `'platform'` iff platform is live+autonomous, else the CEO sentinel. Used by the cron heartbeat to record "routed_to" and (Phase 3) by dashboards that ribbon "escalates to {seat}".

### `FleetBudgetBreach` — interface (Phase 2)

Per-breach detail row: `{ budget: FleetBudget; bucket: FleetCostBucket; tokenOver: boolean; usdOver: boolean; dedupeKey: string; reason: string }`. `dedupeKey` is the stable per-lane key the dashboard_notifications dedup holds on (`fleet_budget_breach:<scope>:<key>`); `reason` is the human "how far over" string used by both the notification body + the activity-ledger reason.

## Callers

- **Phase 2 (live):** [[../inngest/fleet-spend-governor]] cron — every ~30 min sweeps each build-console workspace through `runFleetSpendGovernor`.
- **Phase 2 (planned):** the governor admin route — calls `listFleetBudgets` (owner-gated read) + `upsertFleetBudget` / `deleteFleetBudget` (owner-gated edit) from the Control Tower / settings surface.
- **Phase 3 (planned):** the Control Tower spend line + the platform-department-scorecard — read the rollup + budget status in the shape the scorecard's surfacing milestone reads.

## Gotchas

- **Read-only over cost data.** This library never writes to [[../tables/agent_job_costs]] or [[../tables/ai_token_usage]] — it expresses INTENT (the ceiling); Phase 2 reads it. The cost data is whatever [[fleet-cost]] recorded.
- **Surfaced guardrail, NEVER a kill-switch.** A budget is read by the Phase 2 governor to ESCALATE on overrun — it never throttles, parks, or kills a lane ([[../operational-rules]] § North star).
- **Workspace-override semantics.** `getEffectiveBudget` returns the workspace row when present, else the global default — never both. A workspace prunes its override (via `deleteFleetBudget`) to fall back to the seeded default.
- **`bigint` / `numeric` arrive as strings from PostgREST.** `toBudget` normalizes `token_ceiling` (bigint) and `usd_ceiling_cents` (numeric) into `number`s on the way out so callers don't have to.
- **Loop-guard is "one OPEN at a time," not "one ever."** `escalateBudgetBreach` (Phase 2) dedupes on an UNDISMISSED [[../tables/dashboard_notifications]] row with the matching `metadata.dedupe_key`. Once the operator dismisses the escalation, a still-over budget re-surfaces a fresh notification + a NEW `budget_breach` activity row on the next sweep — that's the "re-surface on persistence" half of the spec's loop-guard.
- **Per-window rollup batching.** `runFleetSpendGovernor` collects the DISTINCT `window_days` across the effective budgets and issues one `rollupFleetCost({ sinceDays })` per window. Default seed = 7 everywhere, so the typical run does ONE rollup query (the same workspace doesn't get N round-trips for N budgets).
- **`$` ceilings only matter where the bucket carries `$`.** A `usd_ceiling_cents` on a Max-only lane (e.g. `build`) is a no-op — the bucket's `usd_cents` is null (no per-token bill), so `usdOver` stays false. Only API-billed buckets contribute to the `$` axis.

## Related

[[../tables/fleet_budgets]] · [[fleet-cost]] · [[../tables/agent_job_costs]] · [[approval-router]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[../inngest/fleet-spend-governor]] · [[../specs/fleet-spend-governor]] · [[../specs/fleet-cost-metering]] · [[../specs/platform-department-scorecard]] · [[../operational-rules]] (§ North star)
