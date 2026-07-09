# libraries/meta/attribution

Meta variant attribution — Storefront Iteration Engine Phase 2. Ties ad spend →
session → PDP/lander variant → order and persists per-`(meta_ad_id, variant, day)`
spend + revenue into [[../tables/meta_attribution_daily]], reporting the named
`variant_attribution_coverage`. Read downstream by the Phase 3 scorecards.

**File:** `src/lib/meta/attribution.ts`

## The chain (v1, deterministic)

- **Ad grain off the order:** [[../tables/orders]]`.attributed_utm_content` ≈ `meta_ad_id`,
  `attributed_utm_source ∈ Meta family` (first-touch, backfilled since 2026-06-14).
  Filtered via [[utm]] `metaFamilyOr('attributed_utm_source')` — a case-insensitive
  `.or()` over `meta` / `facebook` / `instagram` / `fb` / `ig` (Meta stamps `facebook`
  or `fb` or `ig` on many click destinations; a bare `.eq('attributed_utm_source','meta')`
  silently dropped those orders).
- **Variant per order (Phase 2b — persisted-id preferred):** prefer the persisted
  [[../tables/orders]]`.advertorial_page_id` (set at checkout) and
  [[../tables/storefront_sessions]]`.advertorial_page_id` (set at pixel time) → look the id
  up in [[../tables/advertorial_pages]]. Fall back to the Phase 2 URL parse when null:
  order → earliest `utm_source='meta'` session for the `customer_id` → parse `?angle={slug}`
  from `landing_url` → `advertorial_pages.slug` → that row's `variant` (+ `angle_id`, `campaign_id`, id).
  Coverage migrates upward as the persisted columns populate on new traffic.
- **Spend allocation:** the ad's daily spend ([[../tables/meta_insights_daily]], `level='ad'`)
  is split across the variants it drove by the share of in-window Meta **sessions** per
  variant (not revenue — that would flatten ROAS). No resolvable sessions → spend to `(unresolved)`.

## Exports

### `computeVariantAttribution` — function

```ts
async function computeVariantAttribution(p: AttributionParams, startDate: string, endDate: string): Promise<ComputeResult>
```
Computes + upserts rows for the window; returns `{ startDate, endDate, rows, coverage }`.
`AttributionParams = { workspaceId, adAccountId (our uuid) }`. Upserts on
`(workspace_id, meta_ad_id, variant, snapshot_date)`.

### `refreshVariantAttribution` — function

```ts
async function refreshVariantAttribution(p: AttributionParams, opts?: { incrementalDays?: number; backfillDays?: number }): Promise<ComputeResult & { backfilled: boolean }>
```
Picks the window: backfills 90 days on first run (no rows yet for the account), else
incremental (default **7** days — wide enough for Meta's late attribution + first-touch
order backfill). Delegates to `computeVariantAttribution`.

### `UNRESOLVED_VARIANT` — const (`"(unresolved)"`)

The sentinel variant for spend/revenue that can't be resolved to a lander variant.

### Coverage shape

`coverage: { meta_revenue_total_cents, meta_revenue_resolved_cents, variant_attribution_coverage (resolved ÷ total, null if no Meta revenue), meta_orders_total, meta_orders_resolved, meta_orders_without_ad, meta_orders_resolved_via_persisted }`.
`meta_orders_resolved_via_persisted` (Phase 2b) counts orders resolved off a persisted `advertorial_page_id` rather than the URL parse — it climbs as the new columns populate, tracking the migration off URL parsing.

Consumed by [[../tables/media_buyer_sensor_trust]] via [[../specs/media-buyer-sensor-trust-probe]] Phase 2 (`runSensorTrustProbe`) — the probe rolls `variant_attribution_coverage` + the `(unresolved)` share into a per-day green/yellow/red band the Media Buyer agent reads before it trusts ROAS.

## Callers

- `src/lib/inngest/meta-performance.ts` (`meta-attribution-refresh`, fired after each performance sync)
- `scripts/backfill-meta-attribution-90d.ts` — one-shot 90-day forced-recompute per active `meta_ad_accounts` row (attribution-sensor-recalibration Phase 3). Idempotent (upsert on the composite key); pass `incrementalDays: 90` to force the wide window even when rows exist. Follows each recompute with two read-only verification probes: (1) `meta_attribution_daily` last-30d asserts ≥1 row with `variant != '(unresolved)'` AND `roas > 0`; (2) `detectWinners()` returns without throwing and finds ≥1 `(meta_ad_id, variant)` cell with `revenue_cents > 0` (kills the degenerate roas=0 universe).

## Gotchas

- **Reads raw tables here** (sessions/orders/insights/advertorial_pages) — Phase 3 scorecards
  read *this* table, not the raw ones, per the engine's "read metrics from scorecards" invariant.
- Dates are bucketed in **Central time** (matches the storefront dashboards); the window is padded
  ±1 day in UTC so boundary rows aren't missed, then filtered back to the Central range.
- First-touch sessions are queried by `customer_id` **unbounded by window** (the first-touch click
  often predates the order's day); the windowed session scan is only for spend-allocation weights.
- Internal customers / `is_internal` / `is_bot` sessions are excluded, same rule as the funnel.
- **Spend is starved if insights are empty.** `attributed_spend_cents` derives entirely from
  [[../tables/meta_insights_daily]] (`level='ad'`); if that table is empty (the
  meta-insights-ingest-empty-fix regression), every attribution row gets `spend=0` and ROAS
  is meaningless even though revenue/sessions are correct. The fix lives upstream in
  [[meta__performance]] (the rows-written assertion); attribution itself is correct once fed.
- **No swallowed writes (meta-insights-ingest-empty-fix).** The `meta_attribution_daily`
  upsert now checks `{ error }`, reports it via `reportDbError`, and throws; `rows` is the
  count **persisted**, not `records.length`.
- **Meta source family, not literal `meta` (attribution-sensor-recalibration Phase 1).**
  All three source filters (sessions weight, orders, first-touch session) route through
  [[utm]] `metaFamilyOr(column)` so `facebook` / `fb` / `ig` / `instagram` orders
  contribute alongside `meta`. Read-side widening only — the stored raw source value is
  untouched, spend is still conserved through `(unresolved)`.

---

[[../README]] · [[../../CLAUDE]]
