# db-index-orders — composite (workspace_id, created_at DESC) index on orders ✅

**Owner:** [[../functions/platform]] · **Parent:** actions a [[db-health-agent]] finding (signature `dbhealth:slowq:4495583167845289108:orders`) — the one actionable win of the agent's first real run (see [[db-health-agent-accuracy]]). · **Note:** the agent's auto-authored spec body came up empty (a db-health-agent bug — the diagnostic payload didn't materialize to the file); the diagnostic below was recovered + EXPLAIN-verified by hand 2026-06-23.

## Diagnostic
The DB Health Agent flagged a slow query on `public.orders` filtering `workspace_id = $1` and ordering by `created_at DESC` (workspace order timelines / recent-orders loaders). The existing `idx_orders_workspace (workspace_id)` btree serves the equality but leaves the sort unindexed, so the planner reads the whole per-workspace order slice and sorts it on every call. The fix is a composite `(workspace_id, created_at DESC)` index so both the filter and the ordering ride one index scan (no sort).

### The slow query
PostgREST query, **271 ms mean × 14,431 calls = 3,918 s total** (`pg_stat_statements` queryid 4495583167845289108):
```sql
SELECT orders.id, orders.created_at, orders.line_items, orders.shipping_address, orders.customer_id
FROM public.orders
WHERE orders.workspace_id = $1 AND orders.created_at >= $2
ORDER BY orders.created_at DESC
LIMIT $3 OFFSET $4
```

### EXPLAIN (ANALYZE, BUFFERS) — current plan (verified on prod)
```
Limit (actual time=122.571..122.584 rows=50)
  -> Sort (Sort Key: created_at DESC; top-N heapsort)
       -> Seq Scan on orders (actual time=0.227..120.159 rows=7209)
            Filter: (workspace_id = $1 AND created_at >= now()-'90 days')
            Rows Removed by Filter: 125137      ← scans 132,346 rows for the workspace
            Buffers: shared hit=24035
Execution Time: 122.646 ms
```
**Diagnosed cause: Seq Scan + Sort.** No index covers `(workspace_id, created_at)`. The single-column `workspace_id` index isn't selective enough alone (the planner picks a seq scan), and there's a separate sort for the `ORDER BY created_at DESC`. `orders` has ~132k rows for this workspace and grows.

**Confirmed NOT redundant** — `orders` is already indexed on workspace_id, customer_id, (workspace_id, source_name), (workspace_id, order_number), subscription_id, (workspace_id, shopify_customer_id), attributed_utm_campaign, advertorial_page_id, ad_campaign_id, shopify_order_id, braintree_transaction_id, cart_token, normalized_shipping_address — **none** is `(workspace_id, created_at)`.

## The DDL
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_workspace_id_created_at_idx
  ON public.orders (workspace_id, created_at DESC);
```
One index satisfies all three at once: the `workspace_id =` equality (leading col), the `created_at >=` range (second col), and the `ORDER BY created_at DESC` (index already in that order → **no sort**). The plan becomes an index range scan reading ~LIMIT rows instead of a 132k-row scan + heapsort. `CONCURRENTLY` so the build doesn't block writes on the hot orders table; it can't run inside a transaction, so the apply-script issues the statement on its own (no implicit `BEGIN`). Idempotent via `IF NOT EXISTS`. Mirrors the [[../tables/orders|orders]] perf-index convention set by `20260614180000_perf_indexes_customers_orders_tickets.sql`.

## Phase 1 — migration + apply-script ✅
- `supabase/migrations/20260630120000_orders_workspace_created_at_index.sql` — records the index as plain `CREATE INDEX IF NOT EXISTS … (workspace_id, created_at DESC)` (no `CONCURRENTLY`) so fresh/local environments build it inside the migration transaction and the repo schema stays accurate.
- `scripts/apply-orders-workspace-created-at-index.ts` — applies it to PROD with `CREATE INDEX CONCURRENTLY` outside a transaction (the gated prod action), then verifies the index exists via `pg_indexes`.

**Shipped:** `npx tsc --noEmit` clean. Prod apply gated on owner approval (run `npx tsx scripts/apply-orders-workspace-created-at-index.ts`). Brain: [[db-health-agent]] · [[../tables/orders]] · [[../recipes/write-a-migration-apply-script]].

## Verification
- ✅ Run `npx tsx scripts/apply-orders-workspace-created-at-index.ts` → expect `Verified: orders_workspace_id_created_at_idx — CREATE INDEX … (workspace_id, created_at DESC)` printed and exit 0.
- In Supabase SQL editor, `EXPLAIN (ANALYZE) SELECT * FROM public.orders WHERE workspace_id = '<ws-uuid>' ORDER BY created_at DESC LIMIT 50;` → expect an `Index Scan using orders_workspace_id_created_at_idx` with **no** separate `Sort` node and **no** Seq Scan (was a seq scan + top-N heapsort before); execution time drops from ~120 ms to single-digit ms.
- Re-run the apply-script a second time → expect it to be a no-op (`IF NOT EXISTS`) and still exit 0 (idempotent).
- ✅ On a fresh/local DB after `supabase db reset`, `\d public.orders` → expect `orders_workspace_id_created_at_idx` present (migration built it).
- `pg_stat_statements` mean for queryid 4495583167845289108 falls sharply on subsequent calls.
