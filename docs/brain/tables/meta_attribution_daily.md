# meta_attribution_daily

Per-`(meta_ad_id, variant, snapshot_date)` attributed **spend + revenue** — the
Storefront Iteration Engine's Phase 2 output, where per-variant unit economics live.
Written by [[../libraries/meta__attribution]] `computeVariantAttribution`
([[../inngest/meta-performance]] `meta-attribution-refresh`); read by the Phase 3
scorecards. Migration `20260619140000_meta_attribution_daily.sql`. RLS: workspace-member
SELECT, service-role write. See [[../specs/storefront-iteration-engine]] (Phase 2).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `meta_ad_id` | `text` | — | Meta ad id (= [[orders]]`.attributed_utm_content` by publish-time convention) → [[meta_ads]].meta_ad_id |
| `variant` | `text` | — | `advertorial` \| `beforeafter` \| `reasons` \| `(unresolved)` |
| `snapshot_date` | `date` | — | Central-time day of the sessions/orders/spend |
| `advertorial_page_id` | `uuid` | ✓ | → [[advertorial_pages]].id — dominant lander for the cell (null on `(unresolved)`) |
| `angle_id` | `uuid` | ✓ | → [[product_ad_angles]].id (dominant) |
| `ad_campaign_id` | `uuid` | ✓ | → [[ad_campaigns]].id (our campaign that seeded the lander) |
| `meta_adset_id` | `text` | ✓ | parent Meta adset (context, from [[meta_ads]]) |
| `meta_campaign_id` | `text` | ✓ | parent Meta campaign (context, from [[meta_ads]]) |
| `sessions` | `int` | — | in-window Meta sessions for this ad+variant+day (internal/bot excluded) |
| `attributed_spend_cents` | `int8` | — | the ad's daily spend allocated to this variant by **session share** |
| `orders` | `int` | — | Meta-attributed orders resolved to this ad+variant+day |
| `revenue_cents` | `int8` | — | their summed `total_cents` |
| `roas` | `numeric` | — | `revenue_cents / attributed_spend_cents` (derived; 0 when no spend) |
| `synced_at` / `created_at` / `updated_at` | `timestamptz` | — | default: `now()` |

**Unique:** `(workspace_id, meta_ad_id, variant, snapshot_date)` — idempotent upsert key.
Indexes: `(meta_ad_account_id, snapshot_date)`, `(workspace_id, meta_ad_id, snapshot_date)`, `(workspace_id, variant, snapshot_date)`.

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `advertorial_page_id` → [[advertorial_pages]].`id` (on delete set null)
- `angle_id` → [[product_ad_angles]].`id` (on delete set null)
- `ad_campaign_id` → [[ad_campaigns]].`id` (on delete set null)

## Gotchas

- **`(unresolved)` is a real row, not a gap.** Spend on an ad with no resolvable Meta
  sessions, and revenue from a Meta order whose variant couldn't be resolved
  (anonymous click → later direct-session conversion, or a non-lander landing), both
  land under `variant = '(unresolved)'` for that ad+day so spend & revenue are always
  conserved. The named **`variant_attribution_coverage`** metric (resolved ÷ total Meta
  revenue) is returned per run by the library — not stored on this table.
- **Spend is allocated by SESSION share, not revenue.** Splitting an ad's spend by
  revenue would make every variant's ROAS identical (= the ad's blended ROAS). Session
  share reflects that spend buys traffic; per-variant ROAS then measures conversion lift.
  An ad usually drives one lander → 100% of its spend lands on that one variant.
- **`meta_ad_id` is a bare Meta id (text)**, not our uuid — `attributed_utm_content`
  carries it by publish-time convention ([[../tables/ad_publish_jobs]]), not a DB constraint.
- **Meta orders with no `attributed_utm_content`** (Meta source, no ad grain) count toward
  `variant_attribution_coverage`'s denominator but produce **no row** here (nothing to key
  on); the run reports their count as `meta_orders_without_ad`.
- Variant resolution + spend allocation are v1 URL-parse / first-touch joins. Phase 2b
  hardens this by persisting `advertorial_page_id` on sessions/orders.
- **`attributed_spend_cents = 0` on every row ⇒ insights are empty upstream.** Spend
  derives entirely from [[meta_insights_daily]] (`level='ad'`); if that table is empty
  the rollup writes rows (from sessions/orders) but with `spend=0`, making per-variant
  ROAS degenerate. That was the meta-insights-ingest-empty-fix regression — the fix +
  rows-written guard live in [[../libraries/meta__performance]], not here.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
