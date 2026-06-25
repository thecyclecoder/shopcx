# libraries/fleet-spend-governor

Fleet spend governor — the SUPERVISOR surface on the metered-cost proxy ([[fleet-cost]]). Phase 1 (this file) is the **budget-config** side: read + upsert + delete [[../tables/fleet_budgets]] rows. Phase 2 of [[../specs/fleet-spend-governor]] will read these vs. `rollupFleetCost()` and ESCALATE on a trending overrun (never auto-throttle). Authored by [[../specs/fleet-spend-governor]] (M4 of [[../goals/grow-surface-platform-agent-team]]).

**File:** `src/lib/fleet-spend-governor.ts`

## File header

```
Fleet spend governor — the SUPERVISOR on the metered-cost proxy (fleet-cost).

Phase 1 (this file): the BUDGET-config side — read + upsert fleet_budgets rows.
Phase 2 will read these vs. rollupFleetCost() and ESCALATE on a trending overrun
(per the north star: an autonomous tool hits its rail → routes UP to its supervisor,
never auto-throttles a lane). Phase 3 surfaces the spend-to-budget line.
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

## Callers

- **Phase 2 (planned):** `inngest/fleet-spend-governor` cron — calls `getEffectiveBudget` per lane / function, compares against [[fleet-cost]] `rollupFleetCost()`, escalates on a trend-over via [[approval-router]] `resolveApproverLive("platform")` + a [[../tables/director_activity]] row.
- **Phase 2 (planned):** the governor admin route — calls `listFleetBudgets` (owner-gated read) + `upsertFleetBudget` / `deleteFleetBudget` (owner-gated edit) from the Control Tower / settings surface.

## Gotchas

- **Read-only over cost data.** This library never writes to [[../tables/agent_job_costs]] or [[../tables/ai_token_usage]] — it expresses INTENT (the ceiling); Phase 2 reads it. The cost data is whatever [[fleet-cost]] recorded.
- **Surfaced guardrail, NEVER a kill-switch.** A budget is read by the Phase 2 governor to ESCALATE on overrun — it never throttles, parks, or kills a lane ([[../operational-rules]] § North star).
- **Workspace-override semantics.** `getEffectiveBudget` returns the workspace row when present, else the global default — never both. A workspace prunes its override (via `deleteFleetBudget`) to fall back to the seeded default.
- **`bigint` / `numeric` arrive as strings from PostgREST.** `toBudget` normalizes `token_ceiling` (bigint) and `usd_ceiling_cents` (numeric) into `number`s on the way out so callers don't have to.

## Related

[[../tables/fleet_budgets]] · [[fleet-cost]] · [[../tables/agent_job_costs]] · [[approval-router]] · [[../tables/director_activity]] · [[../specs/fleet-spend-governor]] · [[../specs/fleet-cost-metering]] · [[../specs/platform-department-scorecard]] · [[../operational-rules]] (§ North star)
