-- /api/escalated hit Vercel's 300s function timeout because tickets had no
-- index on escalated_at. The route reads every ticket in a workspace where
-- escalated_at IS NOT NULL, orders by escalated_at DESC, LIMIT 500 — Postgres
-- was doing a Seq Scan + in-memory sort of the whole tickets table.
--
-- A partial btree with leading key workspace_id and escalated_at DESC exactly
-- matches that access pattern: Postgres does an Index Scan Backward and stops
-- after 500 rows. Same pattern as idx_tickets_snoozed / idx_tickets_handled_by.
--
-- Applied to PROD manually with `CREATE INDEX CONCURRENTLY` (can't run inside a
-- migration transaction). Recorded here as IF NOT EXISTS (no CONCURRENTLY) so
-- fresh/local environments build it and the repo schema stays accurate — same
-- convention as 20260614180000_perf_indexes_customers_orders_tickets.sql.

CREATE INDEX IF NOT EXISTS idx_tickets_escalated
  ON public.tickets (workspace_id, escalated_at DESC)
  WHERE escalated_at IS NOT NULL;
