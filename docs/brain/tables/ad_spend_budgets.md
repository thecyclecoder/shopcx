# ad_spend_budgets

Per-workspace **ad-DOLLAR budget ceilings** for the Growth director — the supervisor's BUDGET config behind the [[../specs/growth-ad-spend-rail]] (M3 — Spend rails of [[../goals/growth]]). Phase 1 lays down this table; Phase 2 reads it vs. the [[daily_meta_ad_spend]] rollup and **escalates** on a trending overrun (per [[../operational-rules]] § North star — an autonomous tool that hits its rail routes UP to its supervisor, never auto-throttles).

**Distinct from two neighbouring concepts** — keep them straight:

- [[fleet_budgets]] caps the box agent fleet's Max-lane **TOKENS** (the build/plan/fold/… cost), not ad dollars.
- [[iteration_policies]] `per_account_daily_budget_delta_ceiling_cents` caps a **single PASS** of motion (how much the iteration loop may move an account's daily budget in one optimizer step), not a rolling-window spend total.
- `ad_spend_budgets` (this table) caps the **rolling-window ACTUAL spend** for a workspace's ad channel — the Director's leash boundary. Within-ceiling reallocation = autonomous; ceiling raise = explicit CEO escalation.

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); the platform axis is required; the ad-account axis is optional:

- `platform` — `'meta'` / `'google'` / `'amazon'`. The ad-channel envelope.
- `meta_ad_account_id` — `NULL` caps the workspace+platform as a whole; a non-null row caps a single ad-account inside it. `getEffectiveAdSpendBudget` (Phase 2) reads the most-specific row available — a row with `meta_ad_account_id` set beats the platform-wide row for the same workspace+platform.

**Owner-editable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role from the (Phase 2) governor admin surface, never client-side.

**No seed.** Unlike [[fleet_budgets]], this table ships empty — the Growth director leaves the rail un-set by default and the workspace owner opts in by inserting a ceiling. The (Phase 2) governor is a no-op for a workspace with zero rows.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace+platform-wide ceiling; non-null = per-account override |
| `platform` | `text` | NOT NULL · `'meta'` \| `'google'` \| `'amazon'` (check constraint) |
| `window_days` | `int` | spend-summation window in days · default `7` · `> 0 AND <= 90` (matches the Phase 2 rollup window) |
| `usd_ceiling_cents` | `bigint` | NOT NULL · USD ceiling in CENTS for the window · `> 0` |
| `notes` | `text?` | owner notes — surfaced on the editor |
| `updated_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL · `NULL` when a service-role script writes (references `auth.users` directly — `workspace_members` has no unique single-column referent) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `ad_spend_budgets_touch_updated_at` trigger |

## Triggers

- `ad_spend_budgets_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so the owner-editable surface stays accurate.

## Who writes / reads

- **Writer:** (Phase 2) [[../libraries/ad-spend-governor]] `upsertAdSpendBudget` / `deleteAdSpendBudget` from the governor admin route. Service role only — never client-side (the workspace owner edits through an owner-gated API).
- **Reader:** (Phase 2) [[../libraries/ad-spend-governor]] `listAdSpendBudgets` / `getEffectiveAdSpendBudget` (per-account row beats the platform-wide row for the same workspace+platform). The Phase 2 governor compares against the [[daily_meta_ad_spend]] rolling-window sum and escalates on a trend-over via [[../libraries/platform-director]] `escalateDiagnosisToCeo` (`escalationKind='ad_spend_ceiling'`) + a [[director_activity]] row.

## Gotchas

- **A surfaced guardrail, NEVER a kill-switch.** The governor reads this table to ESCALATE on overrun — it never pauses, throttles, or kills a campaign. The owner / director decides the response ([[../operational-rules]] § North star).
- **Per-account override beats platform-wide.** A workspace can hold both a platform-wide row (`meta_ad_account_id IS NULL`) and a per-account row (`meta_ad_account_id` set) for the same platform; `getEffectiveAdSpendBudget` returns the more-specific one. There is no DB-level unique constraint guarding against duplicates within the same scope — Phase 2's writer is responsible for upsert semantics.
- **`window_days` must match the reader.** The Phase 2 governor sums [[daily_meta_ad_spend]] over `budget.window_days`. If you author a `window_days = 1` row, the comparison is over the last 24h, not the seeded 7d window — pick the window consciously.
- **Workspace-scoped only.** There is no global default row (no `workspace_id IS NULL` allowed by the schema) — unlike [[fleet_budgets]], every ad-spend ceiling is owned by exactly one workspace.

## Migration

`supabase/migrations/20260803120000_ad_spend_budgets.sql` — apply with `npx tsx scripts/apply-ad-spend-budgets-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards). RLS: service-role full access + workspace-member SELECT (mirrors [[fleet_budgets]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[daily_meta_ad_spend]] · [[fleet_budgets]] · [[iteration_policies]] · [[director_activity]] · [[../libraries/platform-director]] · [[../specs/growth-ad-spend-rail]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
