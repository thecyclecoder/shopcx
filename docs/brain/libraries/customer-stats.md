# libraries/customer-stats

Live LTV / order-count / first-last-order stats for a customer (and its linked-account group),
computed from the `orders` table. Never trust the denormalized `customers.ltv_cents` / `total_orders`
columns — they drift when Shopify webhooks land with missing/zero counts. Read via this helper.

**File:** `src/lib/customer-stats.ts`

## Exports

### `getCustomerStats(customerId: string): Promise<CustomerStats>`
Single customer. Delegates to `getCustomerStatsBatch([customerId])`.

### `getCustomerStatsBatch(customerIds: string[]): Promise<Map<string, CustomerStats>>`
Batch rollup — one round trip via the `get_customer_stats_batch(p_customer_ids uuid[])` RPC. Returns a
`Map` with an entry for every input id (zeroed when the customer has no orders). Rolls up linked-account
totals (a profile in a 3-account [[../tables/customer_links]] group sees the combined history).

### `CustomerStats` — `{ ltv_cents, total_orders, first_order_at, last_order_at }`

## Server-side aggregation (RPC)

Both functions aggregate SERVER-SIDE in `public.get_customer_stats_batch` (migration
`20260708130000_customer_stats_batch_rpc.sql`), which joins `orders` to each input's
`customer_links` group and returns finished scalars. It also shipped the reusable
`public.resolve_customer_link_group(p_customer_id uuid)` group-expansion primitive
(customer-timeline and the storefront LTV proxy re-implement the same expansion in JS — converge them here).

**Regression note (2026-07-09, migration `20261005180000_customer_stats_batch_rpc_unnest_link_group.sql`):** Phase 5 of the aggregation-layer RPC-ification redefined `resolve_customer_link_group` to return `uuid[]` (a scalar array) instead of `setof uuid`. `get_customer_stats_batch`'s `expanded` CTE now `cross join lateral unnest(public.resolve_customer_link_group(i.cid))` — the array is adapted back into a set of rows before the orders join, so `orders.customer_id = e.order_customer_id` is uuid=uuid again. Fixes Control Tower signature `vercel:348fa052bf4dc7e4` (`operator does not exist: uuid = uuid[]` — every ticket-detail hit 500ing). Aggregation semantics are byte-identical.

**Why the RPC:** the previous JS did one unbounded `.from('orders').select(...).in('customer_id', [...])`
then summed in JS. That read silently truncated at Supabase's **1000-row PostgREST cap**, so the
customers-list sortable `ltv_cents` / `total_orders` columns were **undercounted** on any page whose
customers had >1000 orders between them. Because the list defaults to LTV-desc sort, the order-heaviest
customers cluster onto page 1 — the most-viewed page was the most wrong (measured: a 100-customer batch
undercounted total LTV by ~77%, heavy buyers showing $0/0 orders). Same bug class as
[[../tables/subscriptions]] `estimate_sub_ltv`. See [[storefront-ltv-proxy]], [[db-health]].

## Gotchas

- **LTV refund exclusion is lowercase-only.** LTV excludes `financial_status = 'refunded'` but NOT
  uppercase `'REFUNDED'` / `'PARTIALLY_REFUNDED'` (the RPC preserves the original JS `!== 'refunded'`
  exactly, incl. NULL counting toward LTV). `financial_status` is stored in **mixed casing** in prod
  (`PAID`/`paid`, `REFUNDED`/`refunded`, …) — normalizing that gap is a separate tracked change, kept out
  of the truncation fix so its numeric impact stays attributable.
- **total_orders counts all orders** (refunded included); `first/last_order_at` are min/max over all orders.
- **Linked accounts always roll up.** `customer_links.customer_id` is unique (≤1 group per customer), so
  the expansion is unambiguous.

## Callers

`src/app/api/customers/route.ts` (customers list — recomputes `ltv_cents`/`total_orders` live),
`src/app/api/customers/[id]/route.ts`, `src/app/api/tickets/[id]/route.ts` (sidebar LTV),
`src/lib/storefront/ltv-proxy.ts` (subscriber LTV cross-check), fraud investigate, playbook simulate.

---

[[../README]] · [[../../CLAUDE]]
