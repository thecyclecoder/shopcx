# daily_amazon_product_snapshots

Per-product daily Amazon orders summary — the product/pack-resolved layer beside the aggregate
[[daily_amazon_order_snapshots]]. Source for per-product acquisition-ROAS (the Amazon halo). Written
by [[../libraries/amazon__sync-orders]] `processOrderReport` from the SAME order lines as the aggregate,
also grouped by `asin`. Read by [[../libraries/amazon__per-product-revenue]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `amazon_connection_id` | `uuid` | — | → [[amazon_connections]].id |
| `snapshot_date` | `date` | — | order date (purchase-date, sliced to day) |
| `asin` | `text` | — | `''` sentinel for a no-asin line (default `''`, NOT NULL — keeps the upsert key stable) |
| `product_id` | `uuid` | ✓ | → [[products]].id · **null = unmapped asin** (revenue still counted) |
| `pack_size` | `int2` | ✓ | snapshot of [[amazon_asins]].`pack_size` (1\|2) at sync time |
| `order_bucket` | `text` | — | `recurring` \| `sns_checkout` \| `one_time` (same buckets as the aggregate) |
| `order_count` | `int4` | — | distinct orders for this (date, asin, bucket) · default `0` |
| `units` | `int4` | — | Σ line quantity · default `0` |
| `gross_revenue_cents` | `int4` | — | Σ `item-price` × 100 · default `0` |
| `net_revenue_cents` | `int4` | — | = gross today (no fee subtraction) · default `0` |
| `currency` | `text` | — | default `'USD'` |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(amazon_connection_id, snapshot_date, asin, order_bucket)` — the upsert key.
**Index:** `(workspace_id, product_id, snapshot_date)` — the per-product read path.

## Foreign keys

**Out (this → others):**

- `amazon_connection_id` → [[amazon_connections]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

## Conservation invariant

For every `(snapshot_date, order_bucket)`:
`Σ daily_amazon_product_snapshots.gross_revenue_cents = daily_amazon_order_snapshots.gross_revenue_cents`
— both come from the same order lines summed by `item-price`. Unmapped/no-asin lines land under
`product_id = null` (asin recorded, or `''`) so nothing is lost. The Phase-3 backfill logs any drift.

## Common queries

### Per-product non-renewal revenue for a window (the AcqROAS source)
```ts
const { data } = await admin.from("daily_amazon_product_snapshots")
  .select("product_id, gross_revenue_cents")
  .eq("workspace_id", workspaceId)
  .in("product_id", productIds)
  .in("order_bucket", ["one_time", "sns_checkout"])  // recurring excluded — renewals aren't acquisition
  .gte("snapshot_date", start).lte("snapshot_date", end);
```

## Gotchas

- **Aggregate is untouched.** This table is additive — the ROAS dashboard still reads
  [[daily_amazon_order_snapshots]], whose write is unchanged. Don't migrate the dashboard onto this
  table without preserving the overall number.
- **`asin` is NOT NULL (`''` sentinel).** A NULL asin would defeat the upsert (`NULL != NULL`) and
  duplicate rows every sync. Empty/no-asin lines store `''`, with `product_id = null`.
- **`pack_size` is a point-in-time snapshot** of [[amazon_asins]].`pack_size`; re-running a backfill
  after a pack re-resolution updates it.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
