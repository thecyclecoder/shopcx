# daily_amazon_order_snapshots

Per-day Amazon orders summary for the ROAS / margin dashboards.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `amazon_connection_id` | `uuid` | — | → [[amazon_connections]].id |
| `snapshot_date` | `date` | — |  |
| `order_bucket` | `text` | — |  |
| `order_count` | `int4` | — | default: `0` |
| `gross_revenue_cents` | `int4` | — | default: `0` |
| `net_revenue_cents` | `int4` | — | default: `0` |
| `currency` | `text` | — | default: `'USD'` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `amazon_connection_id` → [[amazon_connections]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("daily_amazon_order_snapshots")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("daily_amazon_order_snapshots")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **Rows are REPLACED, not accumulated.** `processOrderReport` upserts on
  `(amazon_connection_id, snapshot_date, order_bucket)`, so whatever report it is
  handed becomes that day's totals, and then PRUNES any bucket row for a covered
  day the report did not produce. Feeding it a partial day silently overwrites a
  complete one. See [[../inngest/amazon-sync]] § Sync-window invariant and
  [[../libraries/amazon__sync-orders]] § processOrderReport.
- **A day outside the sync window is frozen forever.** These rows are only as
  complete as the last report that covered them; nothing re-checks an old day.
  Amazon settles orders well after the order date, so a short window permanently
  understates revenue (Jun–Aug 2026: ~$18.1K of checkout revenue missing under the
  old `days: 3` cron). Repair with
  `scripts/backfill-amazon-product-snapshots.ts --start <d> --end <d> --apply`.
- **`order_bucket` is derived from `promotion-ids` strings**, not an Amazon field:
  `FBA Subscribe & Save Discount` → `recurring` (renewal, excluded from ROAS),
  `Subscribe and Save Promotion V2` → `sns_checkout` (new signup), everything else
  → `one_time`. If Amazon renames a promotion, renewals silently reclassify as
  `one_time` and inflate ROAS revenue.
- **`gross_revenue_cents` is `item-price` only** — excludes tax, shipping, and
  gift-wrap. This is the figure that reconciles with Seller Central "Ordered
  product sales" (verified 2026-08-24: $52,393 vs the seller app's ~$51.9K).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
