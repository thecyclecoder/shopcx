# fleet_budgets

Per-kind / per-function **spend ceilings** for the box agent fleet — the supervisor's BUDGET config behind the [[../specs/fleet-spend-governor]] (M4 of [[../goals/grow-surface-platform-agent-team]]). Phase 1 lays down this table; Phase 2 reads it vs. the [[../libraries/fleet-cost]] rollup and **escalates** on a trending overrun (per [[../operational-rules]] § North star — an autonomous tool that hits its rail routes UP to its supervisor, never auto-throttles).

Two scope axes — exactly **ONE per row** (DB-enforced via `fleet_budgets_scope_xor`):

- `kind` — an [[agent_jobs]] `kind` lane (`build` / `plan` / `fold` / `spec-chat` / `repair` / …) — caps a single lane.
- `owner_function` — an org-chart function (`platform` / `cs` / `cmo` / `growth` / `retention`) — caps the whole function's envelope (sum across the kinds `ownerFunctionForKind` maps to it, [[../libraries/approval-inbox]]).

Units mirror [[agent_job_costs]] / [[../libraries/fleet-cost]]: **tokens** for the window (the honest Max-lane proxy — Max lanes have no per-token $) plus **`usd_ceiling_cents`** where API-billed rows are expected to contribute. Either ceiling may be `NULL` — a row with neither set is a no-op (intentionally allowed so a budget can be parked while the owner re-tunes). The window itself is a `window_days` integer (1 = daily, 7 = weekly, default `7` to match [[../libraries/fleet-cost]] `rollupFleetCost` and absorb day-to-day spikiness).

**Owner-editable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role from the (Phase 2) governor admin surface, never client-side. `workspace_id = NULL` = a **global default** seeded by the migration; a workspace overrides by inserting its own row with `workspace_id` set — the (Phase 2) governor reads the most-specific row available.

**Seeded ALL-DEFAULTS.** The migration inserts a global default per kind (16 lanes) + per function (5 envelopes) so the governor has a guardrail to read from on day one. Defaults are GUARDRAILS, owner-tunable — they envelope expected 7-day token totals with headroom; the governor escalates on a **trend** over, not a single noisy day.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid?` | → [[workspaces]].id · ON DELETE CASCADE · `NULL` = global default (the seeded rows) |
| `kind` | `text?` | the [[agent_jobs]] `kind` lane this budget caps — set iff scope is `kind`-axis |
| `owner_function` | `text?` | the org-chart function envelope this budget caps — set iff scope is `function`-axis |
| `window_days` | `int` | spend-summation window in days · default `7` · `> 0 AND <= 90` |
| `token_ceiling` | `bigint?` | TOKEN ceiling for the window (input + output + cache) · `> 0` when set · `NULL` = no token guardrail |
| `usd_ceiling_cents` | `numeric?` | USD ceiling in CENTS — meaningful only where genuinely API-billed rows contribute · `> 0` when set · `NULL` = no $ guardrail (the Max-lane default) |
| `notes` | `text?` | owner notes — surfaced on the editor |
| `updated_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL · `NULL` for the seeded defaults (references `auth.users` directly — `workspace_members` has no unique single-column referent) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `fleet_budgets_touch_updated_at` trigger |

## Constraints

- `fleet_budgets_scope_xor` — exactly one of (`kind`, `owner_function`) is set per row. Never both, never neither.
- Partial unique indexes: `fleet_budgets_kind_uniq` on `(coalesce(workspace_id, sentinel), kind) WHERE kind IS NOT NULL`; `fleet_budgets_function_uniq` on `(coalesce(workspace_id, sentinel), owner_function) WHERE owner_function IS NOT NULL`. The `coalesce` sentinel uuid prevents NULL from defeating dedup so a global default is a true singleton per scope.

## Triggers

- `fleet_budgets_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so the owner-editable surface stays accurate.

## Who writes / reads

- **Writer:** the migration (seeds the defaults) + [[../libraries/fleet-spend-governor]] `upsertFleetBudget` / `deleteFleetBudget` from the governor admin route. Service role only — never client-side (the workspace member edits through an owner-gated API).
- **Reader:** [[../libraries/fleet-spend-governor]] `listFleetBudgets` / `getEffectiveBudget` (workspace override beats global default per scope key). The Phase 2 [[../specs/fleet-spend-governor]] cron reads `getEffectiveBudget` per lane + per function, compares against [[../libraries/fleet-cost]] `rollupFleetCost`, and escalates on a trend-over via [[../libraries/approval-router]] `resolveApproverLive("platform")` + a [[director_activity]] row.

## Gotchas

- **A surfaced guardrail, NEVER a kill-switch.** The governor reads this table to ESCALATE on overrun — it never throttles, parks, or kills a lane. The owner / director decides the response ([[../operational-rules]] § North star).
- **`$` only where there is a real bill.** `usd_ceiling_cents` is meaningful only for kinds / functions whose contributing rows carry a real `usage_cost_cents` — Max-lane budgets typically leave it `NULL` and lean on `token_ceiling` instead. A non-null `$` ceiling on a Max-only lane is decorative.
- **Global default vs. workspace override.** A row with `workspace_id IS NULL` is the seeded global default for every workspace. A workspace overrides by inserting its own row with the same scope value (`kind` or `owner_function`) — `getEffectiveBudget` returns the workspace row when present, else the global default.
- **`window_days` must match the reader.** The Phase 2 governor queries `rollupFleetCost({ sinceDays: budget.window_days })`. If you author a `window_days = 1` row, the comparison is over the last 24h, not the seeded 7d window — pick the window consciously.
- **A no-ceiling row is a no-op, not an error.** Both `token_ceiling` and `usd_ceiling_cents` may be `NULL` — the row is on the books but expresses no guardrail. Useful for parking a budget while the owner re-tunes; the governor simply skips it.

## Migration

`supabase/migrations/20260712120000_fleet_budgets.sql` — apply with `npx tsx scripts/apply-fleet-budgets-migration.ts`. Idempotent (`create table if not exists`, partial unique indexes, `on conflict do nothing` on the seed). RLS: service-role full access + workspace-member SELECT (members see their workspace's rows + every global default).

## Related

[[agent_jobs]] · [[agent_job_costs]] · [[../libraries/fleet-cost]] · [[../libraries/fleet-spend-governor]] · [[director_activity]] · [[../libraries/approval-router]] · [[../specs/fleet-spend-governor]] · [[../specs/fleet-cost-metering]] · [[../specs/platform-department-scorecard]] · [[../operational-rules]] (§ North star — supervisable autonomy)
