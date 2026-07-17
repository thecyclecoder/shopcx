# media_buyer_cold_scaler_cac_ltv_snapshots

Per-`(workspace, cold_scaler_cohort, iso_week)` **campaign-scoped CAC:LTV snapshot** for the M4 cold-scaler surface — the durable, cite-able artifact the [[../libraries/media-buyer__cold-scaler-arming-gate]] reads and the CEO grades against. Introduced by [[../specs/bianca-cold-scaler-campaign-cac-ltv-sensor]] Phase 1.

**Why the row exists.** The per-creative ROAS grader in [[../libraries/media-buyer-grader]] cannot see the scaler's CAC:LTV — its grain is a per-creative test row from [[meta_attribution_daily]], not a whole scaler campaign. The workspace-blended composer in [[../libraries/blended-cac-ltv]] aggregates every mapped ad account, not one campaign. So without a campaign-scoped sensor row, the M4 arming gate's `cac_ltv_below_target` / `cac_ltv_unknown` preconditions have no scaler-specific input and the CEO has no gradable metric on the biggest autonomous-spend surface. This row is the promise that the number is not paraphrased — spend + revenue + LTV are stored alongside the derived ratio + band so a red band shows WHY without re-derivation.

**Distinct from [[media_buyer_cold_scaler_arming_authorization]]** — that table pins the shadow→armed authorization decision + reasons; this table pins the CAC:LTV *number* the authorization consumes. The two tables ship in either order; the arming gate prefers this snapshot when a fresh row exists and falls through to the workspace-blended composer when absent (Phase 2 wires that preference into `cold-scaler-arming-gate.ts`).

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); `meta_ad_account_id` is optional and mirrors the [[media_buyer_cold_scaler_cohorts]] shape:

- `workspace_id` — NOT NULL; every snapshot belongs to one workspace.
- `meta_ad_account_id` — `NULL` = workspace-wide row; non-null = per-account row (mirrors the cohort table).
- `cold_scaler_cohort_id` — NOT NULL; the specific scaler cohort being sensed. Cascade-deletes with its cohort so a retired scaler doesn't leave orphan snapshots.
- `iso_week` — ISO 8601 week label (`YYYY-Www`) — the CAC:LTV sample window is weekly.

**Owner-readable, service-role-written.** A workspace member can `SELECT` (RLS); writes go through the service role from the Phase 2 sensor orchestrator, never client-side — mirrors the sibling authorization + cohort tables.

**No seed.** Ships empty — the row is written the first time the Phase 2 orchestrator runs for a live cohort in an ISO-week. A missing row for the current week is treated as "no snapshot" by the arming gate (fall through to the blended composer).

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide default; non-null = per-account snapshot |
| `cold_scaler_cohort_id` | `uuid` | NOT NULL · → [[media_buyer_cold_scaler_cohorts]].id · ON DELETE CASCADE (retiring the cohort drops its snapshots) |
| `iso_week` | `text` | NOT NULL · ISO 8601 week label (`YYYY-Www`) — the sample window |
| `spend_cents` | `bigint` | NOT NULL default `0` · the scaler-scope spend denominator (attributed_spend_cents from [[meta_attribution_daily]] filtered to the scaler campaign's meta_ad_ids, aggregated over the ISO-week) |
| `new_customers` | `int` | NOT NULL default `0` · new-customer count from [[meta_attribution_daily]] over the same filter/window |
| `revenue_cents` | `bigint` | NOT NULL default `0` · attributed revenue over the same filter/window (input to the LTV blend) |
| `ltv_cents` | `bigint` | NOT NULL default `0` · the CAC:LTV numerator — revenue-weighted blended LTV across the products the scaler advertised, resolved via [[../libraries/blended-cac-ltv]] `computeBlendedLtvCents` |
| `cac_ltv_ratio` | `numeric?` | NULLABLE — the derived `ltv_cents / cac_cents` ratio from [[../libraries/blended-cac-ltv]] `blendedCacLtvFromTotals`. `NULL` when the denominator is unknown (band `unknown`) |
| `payback_days` | `numeric?` | NULLABLE — derived payback horizon from the same composer. `NULL` when unknowable |
| `band` | `text` | NOT NULL · CHECK `IN ('red','yellow','green','unknown')` · maps `cac_ltv_ratio` through the Phase 2 boundary constants (green ≥ target, yellow ≥ 0.7×target, red below, unknown when ratio null) |
| `flags` | `jsonb` | NOT NULL default `[]` · carries the [[../libraries/blended-cac-ltv]] assumptions + human-readable notes verbatim so a red band shows WHY without re-derivation |
| `evaluated_at` | `timestamptz` | NOT NULL default `now()` · when the Phase 2 orchestrator ran; a re-evaluation within the same iso_week upserts on the unique key and bumps this |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_cold_scaler_cac_ltv_snapshots_touch_updated_at` trigger |

## Indexes

- `media_buyer_cold_scaler_cac_ltv_snapshots_ws_cohort_week_key` — UNIQUE `(workspace_id, cold_scaler_cohort_id, iso_week)`. One snapshot per `(cohort, week)`. All three columns are NOT NULL so a plain unique index is sufficient — no coalesce fold needed. Re-evaluation within the same iso_week upserts on this key (newest evaluation wins; `updated_at` bumps via the trigger).

## Triggers

- `media_buyer_cold_scaler_cac_ltv_snapshots_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## RLS policies

- `media_buyer_cold_scaler_cac_ltv_snapshots_select` — `FOR SELECT` · workspace members whose `workspace_id` matches (via `workspace_members`).
- `media_buyer_cold_scaler_cac_ltv_snapshots_service` — `FOR ALL` · `auth.role() = 'service_role'`. Phase 2 orchestrator writes go through the service-role client, never a signed-in user.

## Who writes / reads

- **Writer:** [[../libraries/media-buyer__cold-scaler-cac-ltv-sensor]] `runColdScalerCacLtvSensor` orchestrator (Phase 2) — upserts one row per `(workspace, cohort, iso_week)` after aggregating spend / revenue / new-customers from [[meta_attribution_daily]] filtered to the scaler campaign's `meta_ad_ids` and blending LTV via [[../libraries/blended-cac-ltv]].
- **Reader:** [[../libraries/media-buyer__cold-scaler-cac-ltv-sensor]] `readLatestColdScalerCacLtvSnapshot` (the arming-gate consumer chokepoint) — consumed by [[../libraries/media-buyer__cold-scaler-arming-gate]] so the gate's CAC:LTV precondition prefers this campaign-scoped snapshot over the workspace-blended composer when a fresh row exists.

## Gotchas

- **`meta_ad_account_id` is NULLABLE.** Mirrors [[media_buyer_cold_scaler_cohorts]]: a workspace-wide row has `meta_ad_account_id = NULL`. If a future spec needs per-account snapshots to coexist with a workspace-wide row on the same `(cohort, iso_week)` the unique-key shape will need to fold NULL to `''` — today only one row per `(workspace, cohort, iso_week)` is legal regardless of account scope, matching Phase 2's single-orchestrator write path.
- **`bigint` arrives as a string from PostgREST.** The Phase 2 sensor mapper normalizes `spend_cents` / `revenue_cents` / `ltv_cents` to `number` so callers don't have to.
- **`cac_ltv_ratio` / `payback_days` are NULLABLE.** A `null` ratio means the denominator was unknown; band is `unknown` and the arming gate returns `cac_ltv_unknown` — NEVER treat `null` as `0`.
- **`band` is CHECK-constrained.** A future band expansion (e.g. `amber`) requires a migration to widen the CHECK; the Phase 2 sensor + arming gate both switch on this literal set, so widening is not a silent op.
- **`flags` carries the [[../libraries/blended-cac-ltv]] rationale verbatim.** Read this column when a red band lands in the CEO digest — it explains WHY (low sample, high refund rate, missing LTV benchmark, etc.) without re-running the composer.
- **Not a general-purpose CAC:LTV log.** This row is scoped to the SCALER cohort only. The per-creative test grader still uses [[meta_attribution_daily]] directly; the workspace-blended composer still aggregates every mapped account. This table is the missing campaign-grain surface between the two.
- **CASCADE deletes with the cohort.** Retiring a scaler cohort (`ON DELETE CASCADE` on `cold_scaler_cohort_id`) drops its snapshots. Historical rows are preserved by flipping the cohort `is_active=false` instead — same "dormant, not deleted" pattern as [[media_buyer_cold_scaler_cohorts]].

## Migration

- **[[../specs/bianca-cold-scaler-campaign-cac-ltv-sensor]] Phase 1:** `supabase/migrations/20261024120000_media_buyer_cold_scaler_cac_ltv_snapshots.sql` — apply with `npx tsx scripts/apply-media-buyer-cold-scaler-cac-ltv-snapshots-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy `DO $$ IF NOT EXISTS` blocks, `create unique index if not exists`). RLS: service-role full access + workspace-member SELECT (mirrors [[media_buyer_cold_scaler_arming_authorization]] + [[media_buyer_cold_scaler_cohorts]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[media_buyer_cold_scaler_cohorts]] · [[media_buyer_cold_scaler_arming_authorization]] · [[meta_attribution_daily]] · [[../libraries/blended-cac-ltv]] · [[../libraries/media-buyer__cold-scaler-arming-gate]] · [[../libraries/media-buyer-grader]] · [[../specs/bianca-cold-scaler-campaign-cac-ltv-sensor]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
