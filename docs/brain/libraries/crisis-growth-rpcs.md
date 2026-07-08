---
title: Crisis + growth egress RPCs
last_updated: 2026-07-08
tags:
  - library
  - rpc
  - crisis
  - growth
  - roas
brain_refs:
  - [[tables/subscriptions]]
  - [[tables/orders]]
  - [[tables/product_variants]]
  - [[tables/workspaces]]
---

# Crisis + growth egress RPCs

Phase 4 of [[../specs/rpc-ify-aggregation-layer-fix-1000-row-truncation]] — two aggregate RPCs that kill the biggest "page all rows into JS then aggregate" egress sites the audit flagged. Migration: [`20261005160000_phase4_crisis_growth_rpcs.sql`](../../../supabase/migrations/20261005160000_phase4_crisis_growth_rpcs.sql). Both are `STABLE SECURITY DEFINER SET search_path = public` and `GRANT EXECUTE TO service_role, authenticated`.

## 1. `public.crisis_affected_subs(p_workspace, p_variant_id, p_sku) → (affected_count bigint, monthly_revenue_cents bigint, sub_ids uuid[])`

**Caller:** [`src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts`](../../../src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts) — the crisis-detail financial-impact block on the operator dashboard.

**Replaces:** a `while(true) .range(...)` loop that paged EVERY active/paused subscription in the workspace to the app, then a JS `items.some(i => i.sku==='X' || i.variant_id==='Y')` filter + a JS MRR reduce over the survivors. On workspaces with more than 1000 active/paused subs the pager kept running, but every request materialised the whole sub set — the audit's top single-call egress row.

**Match predicate:** `subscriptions.workspace_id = p_workspace AND status IN ('active','paused')` × (any `items[].variant_id = p_variant_id` OR `upper(items[].sku) = upper(p_sku)`). SKU comparison is case-insensitive to match the JS `.toUpperCase()`. Empty-string / NULL parameters short-circuit their branch.

**MRR normalization:** preserves the JS math bit-for-bit — `interval = MONTH → (Σ price*qty)/count`; `WEEK → × (4.33/count)`; `DAY → × (30/count)`. The returned `monthly_revenue_cents` is `round(sum(monthly_cents))::bigint`.

**Return shape:** one row. `sub_ids` is the sorted array of matched `subscriptions.id` — the caller subtracts the set of `crisis_customer_actions.subscription_id` (already-processed) to compute the "still affected" count without a second DB round-trip.

## 2. `public.onsite_nonrenewal_revenue(p_workspace, p_product_ids uuid[], p_start date, p_end date, p_meta_only boolean) → TABLE(product_id uuid, gross_cents bigint, units bigint, order_count bigint)`

**Caller:** [`src/lib/shopify-internal-revenue.ts`](../../../src/lib/shopify-internal-revenue.ts) `getShopifyInternalNonRenewalRevenue` — the on-site half of the AcqROAS numerator ([[../specs/growth-acquisition-roas-spine]]), called PER LINKED PRODUCT GROUP from [`src/lib/blended-cac-ltv.ts`](../../../src/lib/blended-cac-ltv.ts).

**Replaces:** the paginated `product_variants` scan + paginated `orders` scan (line_items JSONB) shipped to app, then a JS `bucketOrder` replay + JS `variantToProduct.get(vid)` + JS `isMetaUtm` filter + JS per-line reduce. This was the single largest sustained egress site — a linked group of 10 products with a 30-day window pulled tens of thousands of order rows to app, PER GROUP, on every ROAS refresh.

**SQL-side parity:** the RPC replays the [`src/lib/order-bucketing.ts`](../../../src/lib/order-bucketing.ts) `bucketOrder` decision tree in a single CASE:

- `recurring` — `workspaces.order_source_mapping[source_name] = 'recurring'` OR `source_name ILIKE '%subscription%'`
- `replacement` — `order_source_mapping[source_name] = 'replacement'` OR `source_name = 'shopify_draft_order'`
- `new_sub` — tags contain `first subscription` OR `subscription_id IS NOT NULL`
- `one_time` — otherwise

`non_renewal := bucket ∈ {new_sub, one_time}` — matches `ONSITE_NON_RENEWAL_BUCKETS`.

**Meta-UTM family filter:** when `p_meta_only`, the RPC applies the same case-insensitive family predicate as [`src/lib/utm.ts`](../../../src/lib/utm.ts) `isMetaUtm` — `lower(attributed_utm_source)` matches `%meta%`, `%facebook%`, `%instagram%`, or is exactly `fb`/`ig`.

**Window boundaries:** `[p_start 00:00 CT, p_end+1 00:00 CT)` converted to UTC via the +05:00 CDT offset — same `T05:00:00Z` boundaries the JS caller used, kept explicit for parity with the ROAS route's daily snapshot.

**Return shape:** one row per matched product with `gross_cents = Σ(price_cents × quantity)` and `order_count = COUNT(DISTINCT order_id)` over the line-items whose `variant_id` mapped to that product. **Plus** one synthetic row with `product_id IS NULL` carrying the OVERALL aggregate — `gross_cents = Σ` per-product, `units = Σ` per-product, `order_count = COUNT(DISTINCT order_id)` over ALL matched line-items. The NULL row preserves the JS `if (productsTouched.size) out.orderCount += 1` semantic — orders touching N products in the group count once toward the outer `orderCount`, N times across the per-product `orderCount`. `blended-cac-ltv.ts` reads `newCustomers = onsite.orderCount`, so the outer count must be the DISTINCT count.

## Verification

- `public.crisis_affected_subs` / `public.onsite_nonrenewal_revenue` exist with the stated signatures + grants.
- Crisis route calls the RPC exactly once and no longer issues `.range(subOffset, subOffset + 999)` over `subscriptions`.
- `getShopifyInternalNonRenewalRevenue` issues a SINGLE `admin.rpc('onsite_nonrenewal_revenue', …)` call per group instead of the paginated `product_variants` + `orders` scans + per-order JS work.
- Parity check on a workspace with >1000 active subs: `crisis_affected_subs` returns the same `monthly_revenue_cents` as a raw SQL replay over the full sub set (the pre-fix JS did not).
- Parity check: `onsite_nonrenewal_revenue` returns the same `grossCents` and `orderCount` as the prior JS output on a sample product/window.

## Gotchas

- Postgres returns `bigint` (`affected_count`, `monthly_revenue_cents`, `gross_cents`, `units`, `order_count`) as a STRING on the wire — every reader coerces with `Number(v) || 0`.
- `crisis_affected_subs` returns exactly ONE ROW. The caller reads `rows[0]` (or `null`).
- `onsite_nonrenewal_revenue` returns N per-product rows PLUS one NULL-product overall row. The caller MUST split on `product_id === null` — the NULL row feeds the outer aggregate (`grossCents`, `units`, `orderCount`), the rest feed `byProduct`.
- Adding a new bucket to `bucketOrder` in TypeScript requires a same-PR update to the CASE branch in the RPC. Both sites are documented in the comments to keep the drift risk visible.
