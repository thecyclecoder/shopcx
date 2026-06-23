# Add a composite index to `orders` (workspace_id, created_at) — kill the seq-scan ⏳

**Owner:** [[../functions/growth]] · **Parent:** a [[db-health-agent]] slow-query fix (signature `dbhealth:slowq:4495583167845289108:orders`). · **Note:** the agent's auto-authored spec body came up empty (a db-health-agent bug — the diagnostic payload didn't materialize to the file); this is the diagnostic, recovered + EXPLAIN-verified by hand 2026-06-23.

## Problem (the slow query)
PostgREST query, **271 ms mean × 14,431 calls = 3,918 s total** (`pg_stat_statements` queryid 4495583167845289108):
```sql
SELECT orders.id, orders.created_at, orders.line_items, orders.shipping_address, orders.customer_id
FROM public.orders
WHERE orders.workspace_id = $1 AND orders.created_at >= $2
ORDER BY orders.created_at DESC
LIMIT $3 OFFSET $4
```

## EXPLAIN (ANALYZE, BUFFERS) — current plan (verified on prod)
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

## The fix — the exact index
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_workspace_id_created_at_idx
  ON public.orders (workspace_id, created_at DESC);
```
One index satisfies all three at once: the `workspace_id =` equality (leading col), the `created_at >=` range (second col), and the `ORDER BY created_at DESC` (index already in that order → **no sort**). The plan becomes an index range scan reading ~LIMIT rows instead of a 132k-row scan + heapsort.

**Confirmed NOT redundant** — `orders` is already indexed on workspace_id, customer_id, (workspace_id, source_name), (workspace_id, order_number), subscription_id, (workspace_id, shopify_customer_id), attributed_utm_campaign, advertorial_page_id, ad_campaign_id, shopify_order_id, braintree_transaction_id, cart_token, normalized_shipping_address — **none** is `(workspace_id, created_at)`.

**Build notes:** `CREATE INDEX CONCURRENTLY` can NOT run inside a transaction — the apply-script must execute it outside a txn block (no BEGIN/COMMIT wrapper; one statement per connection). Use the standard apply-script pattern. After it lands, re-EXPLAIN to confirm an Index Scan replaces the Seq Scan + Sort.

## Verification
- `EXPLAIN` the query above against prod after the index → an **Index Scan** using `orders_workspace_id_created_at_idx`, **no Seq Scan, no Sort node**; execution time drops from ~120 ms to single-digit ms.
- `\d orders` shows the new index; the migration is idempotent (`IF NOT EXISTS`) and ran `CONCURRENTLY` (no write-lock on the live `orders` table).
- `pg_stat_statements` mean for queryid 4495583167845289108 falls sharply on subsequent calls.

## Phase 1 — add the composite index ⏳
Migration (`supabase/migrations/…_orders_workspace_created_at_idx.sql`) + apply-script running `CREATE INDEX CONCURRENTLY` outside a txn; brain note on [[../tables/orders]]. Brain: [[db-health-agent]] · [[../tables/orders]] · [[../recipes/write-a-migration-apply-script]].
