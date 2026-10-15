# libraries/orders-classification

Read chokepoint that classifies any `orders` row on four orthogonal facets — **source**, **origin**, **cartType**, **customerRecency** — and a `queryOrders(ws, filters)` helper that composes the paginated read + classification + first-vs-repeat resolution in one call.

**File:** `src/lib/orders-classification.ts` · **Spec:** [[../specs/orders-classification-sdk]]

## Why this exists

Every place that needs "first-time vs repeat customer" or "checkout vs renewal" was hand-rolling predicates against `orders.source_name` / `subscription_id` / `tags` / `order_type` — a wrong predicate silently mis-buckets acquisition (a renewal read as a new customer, or a subscriber's 2nd checkout mis-flagged as first-time). The purchaser-overlap measurement had to re-derive all of it just to bucket orders. This SDK makes the read correct-by-construction — one canonical classifier + one canonical query surface.

**bucketOrder is the source of truth for `origin` + `cartType`.** classifyOrder DELEGATES to [[order-bucketing]] `bucketOrder` for those facets and never re-implements the renewal/subscription predicate — a drift there would silently corrupt ROAS. Enforced by a grep guard in `src/lib/orders-classification.test.ts` that fails the build on any inline `source_name.includes("subscription")` re-derivation.

## Facets

| Facet | Values | Populated by |
|---|---|---|
| **source** | `shopify` \| `internal` \| `amazon` | classifyOrder — discriminated from documented tells (`source_name`, `shopify_order_id`, `braintree_transaction_id`, `amplifier_order_id`, `amazon_order_id`) |
| **origin** | `checkout` \| `renewal` | classifyOrder → [[order-bucketing]] `bucketOrder` (`recurring` → `renewal`; everything else → `checkout`) |
| **cartType** | `subscription` \| `one_time` \| undefined | classifyOrder → [[order-bucketing]] `bucketOrder` (`new_sub` → `subscription`; `one_time` → `one_time`; renewal + replacement carry no `cartType`) |
| **customerRecency** | `first_time` \| `repeat` \| undefined | queryOrders (Phase 2) — only defined on **checkout** rows. Renewals never carry it. |

## Exports

```ts
// Phase 1 — pure classifier
function classifyOrder(
  order: {
    source_name?: string | null;
    tags?: string | string[] | null;
    subscription_id?: string | null;
    shopify_order_id?: string | null;
    braintree_transaction_id?: string | null;
    amplifier_order_id?: string | null;
    amazon_order_id?: string | null;
  },
  options?: { sourceMapping?: Record<string, string> },
): {
  source: "shopify" | "internal" | "amazon";
  origin: "checkout" | "renewal";
  cartType?: "subscription" | "one_time";
  customerRecency?: "first_time" | "repeat";
};

// Phase 2 — query surface (composes commerce/order + classifyOrder + batched recency)
function queryOrders(
  workspaceId: string,
  filters?: {
    source?: OrderSource | OrderSource[];
    origin?: OrderOrigin | OrderOrigin[];
    cartType?: OrderCartType | OrderCartType[];
    customerRecency?: CustomerRecency | CustomerRecency[];
    since?: string | Date;    // ISO or Date
    until?: string | Date;    // ISO or Date
    lastDays?: number;        // rolling window (wins over since/until)
    sourceMapping?: Record<string, string>;
    pageSize?: number;        // default 500, capped at 1000
    maxRows?: number;         // default Infinity
  },
  deps?: { admin?: SupabaseClient },  // test injection; defaults to createAdminClient()
): Promise<OrderRow[]>;
```

Every facet accepts either a single value or an array (arrays match ANY of the listed values). All filters AND together. `lastDays` is a rolling window and takes precedence over `since` / `until` when both are set.

## The first-vs-repeat convention

A customer is **`repeat`** if they have ANY prior order — renewals INCLUDED. Matches `customers.first_order_at` / `customers.total_orders` and the welcome-email path (a subscriber's 2nd checkout is not "first-time" just because it's a fresh checkout).

Resolution: `queryOrders` does a self-contained cap-free ASC scan of `orders.created_at` for the customer_ids in the result set (paginates past the 1000-row cap via `(created_at ASC, id ASC)` cursor), builds `first_order_at` per customer, then a checkout row is `first_time` iff its `created_at` `<=` the customer's earliest — otherwise `repeat`. Only checkout rows carry the facet; renewals never do (a `customerRecency` filter therefore also drops renewals from the result).

## Pagination + no silent truncation

`queryOrders` walks `orders` with a `(created_at DESC, id DESC)` cursor and re-issues the same filtered query on each page — no `.limit(1000)` truncation, no missed rows. Same pattern as [[commerce__order]] `listOrders`. A `>1000-row` test fixture in `src/lib/orders-classification.test.ts` pins that guarantee.

## Gotchas

- **Amazon source detection:** `queryOrders` no longer selects the `amazon_order_id` column from the orders table (it does not exist on the schema). Amazon orders are detected from `source_name='amazon'` only. The `classifyOrder` function still accepts `amazon_order_id` as an optional input for direct-pass use cases (e.g., testing), but `queryOrders` relies entirely on `source_name` for Amazon discrimination.

## Callers

- `scripts/_measure-test-purchaser-overlap.ts` — the analytical measurement that Phase 3 refactored onto the SDK. Was the driver for building the SDK in the first place (hand-rolled `bucketOrder` + earliest-order-per-customer before). Now consumes `queryOrders` / `classifyOrder` directly; the UTM → campaign attribution join stays in the script (out of this SDK's scope).

## Related

- [[order-bucketing]] — SoT for `origin` / `cartType`. classifyOrder DELEGATES to it; never re-derives.
- [[commerce__order]] — the paginated `orders` read chokepoint (Display + Mutation ops for individual orders).
- [[customer-stats]] — batched LTV / total_orders / first_order_at via `get_customer_stats_batch` RPC. `queryOrders` resolves recency inline (same convention) rather than a round-trip to this RPC so the SDK stays self-contained.
- [[acquisition-roas]] — the ROAS consumer this SDK protects: a wrong renewal/checkout split silently inflates today's ROAS.
- [[../tables/orders]] · [[../tables/customers]]
