# libraries/order-bucketing

Canonical order → revenue bucket, shared so ROAS + the daily snapshot can't drift.

**File:** `src/lib/order-bucketing.ts`

## Export

```ts
function bucketOrder(
  order: { source_name?; tags?; subscription_id? },
  sourceMapping?: Record<string, string>,   // workspaces.order_source_mapping
): "recurring" | "new_sub" | "one_time" | "replacement"
```

## Logic

1. `recurring` — `sourceMapping[src] === "recurring"` OR `source_name` contains `"subscription"` (catches Shopify `subscription_contract*` **and** internal `internal_subscription_renewal`). Excluded from ROAS revenue.
2. `replacement` — mapped `"replacement"` OR `shopify_draft_order`. Excluded from ROAS + totals.
3. else **checkout family** → `new_sub` if it created/joined a sub, else `one_time`.

**New-sub signal:** Shopify checkouts carry a `"first subscription"` tag. Internal storefront orders (`source_name="storefront"`, written by `/api/checkout`) carry **no tag**, so `subscription_id != null` is the signal — a storefront order with a `subscription_id` created/joined a sub; without one it's one-time.

## Callers

- [[../inngest/daily-order-snapshot]] — fills [[../tables/daily_order_snapshots]] (past days).
- `src/app/api/workspaces/[id]/analytics/roas/route.ts` — live "today" path.

## Why it exists

Before this, the two paths disagreed: internal renewals (`internal_subscription_renewal`) were bucketed `recurring` by the snapshot but `one_time` by the live ROAS query (which only special-cased `subscription_contract_checkout_one`), so internal renewal revenue **inflated today's ROAS**. And internal storefront subscription checkouts were counted as `one_time` everywhere (no "first subscription" tag). Routing both through `bucketOrder` fixes both.

## Gotchas

- `order_type` and `tags` are **null** on internal orders — don't rely on them for internal; use `subscription_id`.
- The live ROAS path must load `workspaces.order_source_mapping` and pass it in, or mapped sources (e.g. numeric Shopify ids → replacement) fall back to checkout-family.

## Consumers of this SoT

- [[orders-classification]] — wraps `bucketOrder` in the four-facet `classifyOrder` + `queryOrders` chokepoint that also adds source (shopify | internal | amazon) and first-vs-repeat discrimination. Callers that need those facets go through the SDK; `bucketOrder` stays the SoT for `origin` / `cartType`.

## Related

[[../tables/daily_order_snapshots]] · [[../tables/orders]] · [[../inngest/daily-order-snapshot]] · [[orders-classification]]
