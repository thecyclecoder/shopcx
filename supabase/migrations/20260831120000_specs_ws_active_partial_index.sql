-- DB Health Agent flagged this seq scan (pg_stat_statements 4608471940106465663):
--
--   SELECT spec, phases FROM public.list_specs_with_phases($1::uuid, $2::text, $3::timestamptz)
--   calls=79447 mean=100ms total=7969s
--
-- EXPLAIN shows:
--   Seq Scan on specs s (cost=0.00..684.90 rows=140 width=64)
--     Filter: ((($3 IS NULL) OR (updated_at > $3)) AND (workspace_id = $1)
--             AND CASE $2 WHEN 'active' THEN ((status IS NULL) OR (status <> 'folded')) ...)
--
-- The two existing indexes both miss the hot path:
--   • specs_ws_status_idx (workspace_id, status) — the CASE-on-status wrapper is not
--     sargable, so the planner can't use the composite for the `'active'` branch.
--   • specs_ws_updated_at_idx (workspace_id, updated_at) — no help when $3 is NULL
--     (the common full-board caller), and index scan cost still loses to seq scan on
--     the whole-table variant because the `status <> 'folded'` filter must be reapplied.
--
-- A PARTIAL composite whose predicate EXACTLY matches the `'active'` scope is the
-- targeted fix: the planner can drop the CASE filter entirely and index-scan a much
-- smaller set. It also covers both p_since=NULL and p_since>value (the leading
-- (workspace_id) key handles the former; adding updated_at handles the latter for
-- Phase 5's incremental cursor callers).
--
-- Applied to PROD manually with `CREATE INDEX CONCURRENTLY` (can't run inside a
-- migration transaction). Recorded here as `IF NOT EXISTS` (no CONCURRENTLY) so
-- fresh/local environments build it and the repo schema stays accurate — same
-- convention as 20260817120000_tickets_escalated_at_partial_index.sql.

CREATE INDEX IF NOT EXISTS specs_ws_active_updated_at_idx
  ON public.specs (workspace_id, updated_at)
  WHERE (status IS NULL OR status <> 'folded');
