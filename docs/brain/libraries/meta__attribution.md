# libraries/meta/attribution

Meta variant attribution — Storefront Iteration Engine Phase 2. Ties ad spend →
session → PDP/lander variant → order and persists per-`(meta_ad_id, variant, day)`
spend + revenue into [[../tables/meta_attribution_daily]], reporting the named
`variant_attribution_coverage`. Read downstream by the Phase 3 scorecards.

**File:** `src/lib/meta/attribution.ts`

## The chain (v1, deterministic)

- **Ad grain off the order:** [[../tables/orders]]`.attributed_utm_content` ≈ `meta_ad_id`,
  `attributed_utm_source='meta'` (first-touch, backfilled since 2026-06-14).
- **Variant per order:** order → earliest `utm_source='meta'` [[../tables/storefront_sessions]]
  for the `customer_id` → parse `?angle={slug}` from `landing_url` →
  [[../tables/advertorial_pages]]`.slug` → that row's `variant` (+ `angle_id`, `campaign_id`, id).
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

`coverage: { meta_revenue_total_cents, meta_revenue_resolved_cents, variant_attribution_coverage (resolved ÷ total, null if no Meta revenue), meta_orders_total, meta_orders_resolved, meta_orders_without_ad }`.

## Callers

- `src/lib/inngest/meta-performance.ts` (`meta-attribution-refresh`, fired after each performance sync)

## Gotchas

- **Reads raw tables here** (sessions/orders/insights/advertorial_pages) — Phase 3 scorecards
  read *this* table, not the raw ones, per the engine's "read metrics from scorecards" invariant.
- Dates are bucketed in **Central time** (matches the storefront dashboards); the window is padded
  ±1 day in UTC so boundary rows aren't missed, then filtered back to the Central range.
- First-touch sessions are queried by `customer_id` **unbounded by window** (the first-touch click
  often predates the order's day); the windowed session scan is only for spend-allocation weights.
- Internal customers / `is_internal` / `is_bot` sessions are excluded, same rule as the funnel.

---

[[../README]] · [[../../CLAUDE]]
