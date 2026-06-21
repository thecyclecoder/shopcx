# libraries/amazon/per-product-revenue

Per-product Amazon **non-renewal** revenue — the AcqROAS source (Phase 4 of
[[../specs/amazon-per-product-sales-attribution]]). Sums [[../tables/daily_amazon_product_snapshots]]
for a linked-product group over a date window; the Amazon halo that
[[../specs/growth-acquisition-roas-spine]] credits to Meta spend.

**File:** `src/lib/amazon/per-product-revenue.ts`

## Exports

### `AMAZON_NON_RENEWAL_BUCKETS` — const
`["one_time", "sns_checkout"]` — the acquisition buckets. `recurring` (Subscribe & Save auto-renewals)
is excluded; renewals are not acquisition. Mirrors the on-site [[order-bucketing]] non-renewal family.

### `getAmazonNonRenewalRevenue` — function
```ts
async function getAmazonNonRenewalRevenue(params: {
  workspaceId: string;
  productIds: string[];   // the full linked-group product_ids
  startDate: string;      // YYYY-MM-DD, inclusive
  endDate: string;        // YYYY-MM-DD, inclusive
}): Promise<{
  grossCents: number; netCents: number; orderCount: number; units: number;
  byProduct: Record<string, { grossCents; netCents; units; orderCount }>;
}>
```
Reads `daily_amazon_product_snapshots` filtered to `product_id ∈ productIds`,
`order_bucket ∈ AMAZON_NON_RENEWAL_BUCKETS`, `snapshot_date ∈ [start, end]`. Returns the group total
plus a `byProduct` breakdown.

## Callers

- (Phase 4 consumer) `growth-acquisition-roas-spine` AcqROAS computation — wires this as the Amazon channel.

## Gotchas

- **Unmapped revenue is invisible here.** Rows with `product_id = null` are excluded by the
  `.in("product_id", …)` filter — that's intended (we only credit resolved products), but it means the
  group total can be less than the aggregate. Resolve ASINs (Phase 1) to pull revenue in.

---

[[../README]] · [[../../CLAUDE]]
