# media_buyer_sensor_trust

Per-workspace **daily sensor-trust snapshot** for the Media Buyer agent — Phase 1 of [[../specs/media-buyer-sensor-trust-probe]] (M1 milestone of [[../goals/autonomous-media-buyer-supervision]]). One row per `(workspace_id, meta_ad_account_id, snapshot_date)` records whether the attribution sensor was clean enough that day for the Media Buyer's shadow-mode calls to trust ROAS.

**Why it exists.** The Media Buyer's shadow-mode grading only pencils out if the ROAS numbers it's grading against are real. If the [[../libraries/meta__attribution]] coverage ratio dropped that day (unresolved revenue spiked, spend allocation drifted, sample was too thin), the day's calls should be **denied**, not graded. Phase 3 short-circuits `runMediaBuyerLoop` when the newest row is missing / stale / `band='red'` — directly serving the goal's "shadow-mode winner/loser calls match a human review within tolerance" success criterion by refusing to grade shadow calls against untrusted spend/revenue.

**Distinct from three neighbouring signals** — keep them straight:

- [[ad_spend_budgets]] caps the **rolling-window DOLLAR** ceiling ([[../libraries/ad-spend-governor]]) — a standing supervisor's leash.
- [[media_buyer_test_cohorts]] designates the **entry rail** ad set + a daily USD ceiling at PUBLISH time.
- [[meta_attribution_daily]] is the **raw per-day attribution rollup** — this table is the DERIVED **sensor-quality** signal computed from it, not the rollup itself.

**Scope axes** — every row is workspace-scoped (`workspace_id NOT NULL`); the ad-account axis is optional:

- `meta_ad_account_id` — `NULL` = workspace-wide fallback snapshot; a non-null row scopes the snapshot to one connected Meta ad account. Phase 2's `runSensorTrustProbe` computes the workspace-wide row when the caller passes `metaAdAccountId=null`, and a per-account row when it's set.
- `snapshot_date` — one row per calendar date (Central time, matching the [[../libraries/meta__attribution]] bucket).

**Owner-editable? No.** This table is **service-role-written only** — the Phase 2 probe is the only writer. Workspace members can `SELECT` (RLS) so the future admin/telemetry surface can display the band + reasons, but they never edit rows directly. Band thresholds are authored on the cohort ([[media_buyer_test_cohorts]] `green_min_coverage` / `yellow_min_coverage` / `max_unresolved_share`), not here.

**Ships empty.** Every workspace starts with zero rows — the Media Buyer's Phase 3 short-circuit reads a missing snapshot as **untrusted** (a red-band-equivalent denial). The workspace has to have the sensor-trust-probe lane running before its Media Buyer can spend.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · `NULL` = workspace-wide fallback; non-null = per-account snapshot |
| `snapshot_date` | `date` | NOT NULL · Central-time calendar date the sensor was probed for |
| `window_days` | `int` | NOT NULL · lookback window the probe used · `> 0 AND <= 90` · matches [[../libraries/meta__attribution]]'s default 7-day window |
| `coverage_ratio` | `numeric?` | resolved-revenue ÷ total-Meta-revenue for the window; `NULL` when the window has no Meta revenue (see [[../libraries/meta__attribution]] § Coverage shape) |
| `unresolved_revenue_share` | `numeric?` | share of revenue attributed to the `(unresolved)` variant sentinel · complement axis of `coverage_ratio` |
| `spend_allocation_ratio` | `numeric?` | share of window spend the probe was able to allocate to a resolved variant |
| `sample_orders` | `int` | NOT NULL default `0` · orders in the sample window · `>= 0` · used as the sample-thinness signal |
| `sample_spend_cents` | `bigint` | NOT NULL default `0` · window spend in CENTS · `>= 0` (Meta reports the source-of-truth in CENTS via [[meta_insights_daily]]) |
| `band` | `text` | NOT NULL · `'green'` \| `'yellow'` \| `'red'` (check constraint) · the trust verdict the Media Buyer reads |
| `reasons` | `jsonb` | NOT NULL default `'[]'` · array of reason tokens the probe emitted (e.g. `'insufficient_sample'`, `'stale_snapshot'`, `'low_coverage'`) so the Phase 3 denial path can carry a diagnosable payload into `director_activity` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by the `media_buyer_sensor_trust_touch_updated_at` trigger on any upsert re-write |

## Indexes

- `media_buyer_sensor_trust_ws_account_date_key` — UNIQUE `(workspace_id, coalesce(meta_ad_account_id::text, ''), snapshot_date)`. One snapshot per `(workspace, meta_ad_account, snapshot_date)`; folding NULL `meta_ad_account_id` to `''` lets the workspace-wide row coexist with per-account rows for the same date without colliding. The Phase 2 probe writes through `.upsert(..., { onConflict: 'workspace_id, coalesce(meta_ad_account_id::text, ...), snapshot_date' })`.

## Triggers

- `media_buyer_sensor_trust_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so an upsert re-write (same `snapshot_date`) leaves a fresh timestamp for the Phase 3 gate to compare against.

## Who writes / reads

- **Writer:** (Phase 2) [[../libraries/media-buyer__sensor-trust-probe]] `runSensorTrustProbe` — the only writer. Service-role only, invoked from the `sensor-trust-probe` box lane on cadence. There is no client-side write path.
- **Reader:** (Phase 3) [[../libraries/media-buyer-agent]] `runMediaBuyerLoop` — reads the newest row for `(workspaceId, metaAdAccountId)` ordered by `snapshot_date desc, limit 1` before calling `computeMediaBuyerPlan`. A missing / stale-past-48h / `band='red'` row writes one [[director_activity]] row with `action_kind='media_buyer_sensor_trust_denied'` + returns the dormant summary shape from [[../libraries/media-buyer-agent]] § Policy contract.

## Gotchas

- **Missing row = untrusted, not lenient.** Phase 3 treats "no snapshot" the same as `band='red'`. A workspace with no sensor-trust-probe lane running has an OFF Media Buyer — that is the correct default.
- **`snapshot_date` is Central-time, not UTC.** Matches [[../libraries/meta__attribution]] and the storefront dashboards. A UTC-midnight probe run gets bucketed to the Central-time calendar day it fell in.
- **Thresholds live on the cohort, not here.** `green_min_coverage`, `yellow_min_coverage`, `max_unresolved_share` are authored on [[media_buyer_test_cohorts]] so the cohort owner controls the bands. The Phase 2 probe reads them from there; missing values fall back to a code-level default so an already-seeded cohort keeps working.
- **`(unresolved)` denominator matters.** `unresolved_revenue_share` is the revenue routed to the `UNRESOLVED_VARIANT` sentinel ÷ total Meta revenue for the window ([[meta_attribution_daily]] § Gotchas — spend is conserved through `(unresolved)`). A spike here is the correct signal that ROAS is untrustworthy.
- **Composite unique is expression-based.** The uniqueness is on the `coalesce(...)` expression, so the upsert must pass the `onConflict` list explicitly (or fall back to a `select`-then-`insert` compare-and-set). A raw `.insert()` that ignores the conflict path duplicates rows.
- **Sample-thin windows band red.** The Phase 2 probe emits `'insufficient_sample'` with `sample_orders=0` → `band='red'`. This is intentional — a two-order window is not evidence the sensor is clean.
- **`bigint` arrives as a string from PostgREST.** Readers should normalize `sample_spend_cents` to `number` before comparing.

## Migration

`supabase/migrations/20260928120000_media_buyer_sensor_trust.sql` (this table) + `supabase/migrations/20260928130000_media_buyer_test_cohorts_sensor_trust_thresholds.sql` (additive threshold columns on [[media_buyer_test_cohorts]]). Apply with `npx tsx scripts/apply-media-buyer-sensor-trust-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards, `add column if not exists`). RLS: service-role full access + workspace-member SELECT (mirrors [[ad_spend_budgets]]).

## Related

[[workspaces]] · [[meta_ad_accounts]] · [[meta_attribution_daily]] · [[meta_insights_daily]] · [[media_buyer_test_cohorts]] · [[ad_spend_budgets]] · [[director_activity]] · [[../libraries/meta__attribution]] · [[../libraries/media-buyer-agent]] · [[../specs/media-buyer-sensor-trust-probe]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
