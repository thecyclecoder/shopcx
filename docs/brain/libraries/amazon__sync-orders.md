# libraries/amazon/sync-orders

Amazon SP-API order pull.

**File:** `src/lib/amazon/sync-orders.ts`

## File header

```
Amazon order sync: request report → poll → parse TSV → upsert daily snapshots
```

## Exports

### `requestReport` — function

```ts
async function requestReport(connectionId: string, marketplaceId: string, startDate: string, endDate: string,) : Promise<string>
```

### `pollReportStatus` — function

```ts
async function pollReportStatus(connectionId: string, marketplaceId: string, reportId: string,) : Promise<
```

### `downloadReport` — function

```ts
async function downloadReport(connectionId: string, marketplaceId: string, documentId: string,) : Promise<string>
```

### `processOrderReport` — function

```ts
async function processOrderReport(params: { workspaceId: string; connectionId: string; reportTsv: string; })
  : Promise<{ orderCount: number; snapshotCount: number; productSnapshotCount: number }>
```
Parses the TSV and upserts TWO snapshot layers from the SAME lines: the aggregate
[[../tables/daily_amazon_order_snapshots]] (grouped by `date|bucket`, **unchanged**) AND the per-product
[[../tables/daily_amazon_product_snapshots]] (grouped by `date|asin|bucket`, resolving `asin →
{product_id, pack_size}` from [[../tables/amazon_asins]]; unmapped → `product_id null`).

### `resolveAsinPack` — function
```ts
async function resolveAsinPack(admin, asin: string, opts?: { orderPriceCents?: number; connectionId?: string })
  : Promise<{ pack_size: number | null; units_per_pack: number | null; pack_resolved_by: ... | null }>
```
Resolves 1-pack vs 2-pack for an ASIN via **per-product price bands** (1-pack base = lowest positive
`current_price_cents` among the product's ASINs; ~2× = 2-pack) → order-line price fallback → title
servings. Never overrides a `manual` mapping. See [[../tables/amazon_asins]] § Pack resolution.

## Callers

- `src/lib/inngest/amazon-sync.ts`
- `src/lib/inngest/today-sync.ts`
- `scripts/backfill-amazon-product-snapshots.ts` (Phase 3 backfill)

## Tables written

- [[../tables/daily_amazon_order_snapshots]] (aggregate, unchanged)
- [[../tables/daily_amazon_product_snapshots]] (per-product layer)
- [[../tables/amazon_sales_channels]] · [[../tables/amazon_connections]] (`last_sync_at`)

## Gotchas

- **Conservation holds by construction** — both snapshot layers sum the same `item-price` lines, so per
  every `(date, bucket)`, Σ per-product gross = aggregate gross. The backfill reconciles + logs drift.

---

[[../README]] · [[../../CLAUDE]]
