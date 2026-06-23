# libraries/shopify-internal-revenue

Per-product **on-site (Shopify + internal storefront) non-renewal revenue** — the on-site half of
AcqROAS ([[../specs/growth-acquisition-roas-spine]] Phase 1). The mirror image of
[[amazon__per-product-revenue]]: sums LINE-ITEM revenue for a linked-product group over a date window,
counting only orders that bucket as non-renewal. Consumed by [[acquisition-roas]].

**File:** `src/lib/shopify-internal-revenue.ts`

## Exports

### `ONSITE_NON_RENEWAL_BUCKETS` — const
`["new_sub", "one_time"]` — the [[order-bucketing]] checkout family that counts as acquisition.
`recurring` (renewals) and `replacement` (drafts) are excluded — renewals are not acquisition.

### `getShopifyInternalNonRenewalRevenue` — function
```ts
async function getShopifyInternalNonRenewalRevenue(params: {
  workspaceId: string;
  productIds: string[];   // the full linked-group product_ids
  startDate: string;      // YYYY-MM-DD, inclusive (Central-time, matching ROAS snapshot boundaries)
  endDate: string;        // YYYY-MM-DD, inclusive
  metaOnlyUtm?: boolean;  // default false — when true, only attributed_utm_source=meta orders count
}): Promise<{
  grossCents: number; orderCount: number; units: number;
  byProduct: Record<string, { grossCents; units; orderCount }>;
}>
```
1. Resolves `productIds` → the set of `product_variants.shopify_variant_id` (keeping variant→product).
2. Walks `orders` in the window (paginated), bucketing each via [[order-bucketing]] `bucketOrder` with
   the workspace's `order_source_mapping` — so internal storefront subs/renewals bucket the same way
   they do in the snapshot cron and the ROAS route (no drift).
3. For each non-renewal order, sums `price_cents × quantity` over the line items whose `variant_id` is
   in the group. Returns the group total + a `byProduct` split.

## Callers

- [[acquisition-roas]] `computeAcqROAS` — the on-site channel of the AcqROAS numerator.

## Gotchas

- **Line-item revenue, not order total.** An order can mix group + non-group items (e.g. the accessory
  Bamboo Coffee Mug, which is NOT in the coffee group) — only matching lines are summed.
- **Reuses `bucketOrder`, never re-implements it.** New-sub detection for internal storefront orders
  relies on `subscription_id` (they carry no Shopify "first subscription" tag) — handled inside
  `bucketOrder`.
- **Central-time window → UTC.** `created_at` is UTC; the window is converted `[start 00:00, end+1 00:00)`
  Central (CDT +05:00) to match the ROAS dashboard's snapshot boundaries.
- **`metaOnlyUtm=true`** implements the inverse of the spec's "non-utm sales are Meta-derivative"
  assumption; the baseline and the default AcqROAS path count ALL non-renewal sales.
- Reproduces the spec baseline: coffee Shopify+internal non-renewal = **$5,896** for Jun 7–20.

---

[[../README]] · [[../../CLAUDE]]
