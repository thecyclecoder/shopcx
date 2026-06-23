# db-index-orders — composite (workspace_id, created_at DESC) index on orders ✅

**Owner:** [[../functions/platform]] · **Parent:** actions a [[db-health-agent]] finding (signature `dbhealth:slowq:4495583167845289108:orders`) — the one actionable win of the agent's first real run (see [[db-health-agent-accuracy]]).

## Diagnostic
The DB Health Agent flagged a slow query on `public.orders` filtering `workspace_id = $1` and ordering by `created_at DESC` (workspace order timelines / recent-orders loaders). The existing `idx_orders_workspace (workspace_id)` btree serves the equality but leaves the sort unindexed, so the planner reads the whole per-workspace order slice and sorts it on every call. The fix is a composite `(workspace_id, created_at DESC)` index so both the filter and the ordering ride one index scan (no sort).

## The DDL
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_workspace_id_created_at_idx
  ON public.orders (workspace_id, created_at DESC);
```
`CONCURRENTLY` so the build doesn't block writes on the hot orders table; it can't run inside a transaction, so the apply-script issues the statement on its own (no implicit `BEGIN`). Idempotent via `IF NOT EXISTS`. Mirrors the [[../tables/orders|orders]] perf-index convention set by `20260614180000_perf_indexes_customers_orders_tickets.sql`.

## Phase 1 — migration + apply-script ✅
- `supabase/migrations/20260630120000_orders_workspace_created_at_index.sql` — records the index as plain `CREATE INDEX IF NOT EXISTS … (workspace_id, created_at DESC)` (no `CONCURRENTLY`) so fresh/local environments build it inside the migration transaction and the repo schema stays accurate.
- `scripts/apply-orders-workspace-created-at-index.ts` — applies it to PROD with `CREATE INDEX CONCURRENTLY` outside a transaction (the gated prod action), then verifies the index exists via `pg_indexes`.

**Shipped:** `npx tsc --noEmit` clean. Prod apply gated on owner approval (run `npx tsx scripts/apply-orders-workspace-created-at-index.ts`).

## Verification
- Run `npx tsx scripts/apply-orders-workspace-created-at-index.ts` → expect `Verified: orders_workspace_id_created_at_idx — CREATE INDEX … (workspace_id, created_at DESC)` printed and exit 0.
- In Supabase SQL editor, `EXPLAIN (ANALYZE) SELECT * FROM public.orders WHERE workspace_id = '<ws-uuid>' ORDER BY created_at DESC LIMIT 50;` → expect an `Index Scan using orders_workspace_id_created_at_idx` with **no** separate `Sort` node (was a seq/heap scan + Sort before).
- Re-run the apply-script a second time → expect it to be a no-op (`IF NOT EXISTS`) and still exit 0 (idempotent).
- On a fresh/local DB after `supabase db reset`, `\d public.orders` → expect `orders_workspace_id_created_at_idx` present (migration built it).
