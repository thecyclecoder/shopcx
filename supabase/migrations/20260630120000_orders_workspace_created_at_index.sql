-- Performance index diagnosed by the DB Health Agent
-- (signature dbhealth:slowq:4495583167845289108:orders).
--
-- The orders list / history reads filter `workspace_id = $1` and order by
-- `created_at DESC` (workspace order timelines, recent-orders loaders). The
-- existing single-column `idx_orders_workspace (workspace_id)` btree serves the
-- equality but leaves the sort unindexed → the planner sorts the whole
-- per-workspace slice on every call. A composite (workspace_id, created_at DESC)
-- lets both the filter and the ordering ride one index (index scan, no sort).
--
-- Applied to PROD with `CREATE INDEX CONCURRENTLY` (see
-- scripts/apply-orders-workspace-created-at-index.ts) because CONCURRENTLY can't
-- run inside a migration transaction. Recorded here as plain IF NOT EXISTS (no
-- CONCURRENTLY) so fresh/local environments build it and the repo schema stays
-- accurate.
CREATE INDEX IF NOT EXISTS orders_workspace_id_created_at_idx
  ON public.orders (workspace_id, created_at DESC);
