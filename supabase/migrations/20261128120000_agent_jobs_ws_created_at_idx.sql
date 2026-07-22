-- agent-jobs-recent-list-idx — index the workspace-scoped, created_at-ordered read path.
--
-- Residual after agent-jobs-read-amplification (20261122120000): a paginated "recent jobs" reader
-- (SELECT * ... WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT/OFFSET) was the largest
-- remaining agent_jobs cost — ~14 calls/min, and each one seq-scanned the whole table then top-N
-- heapsorted it. Measured plan (EXPLAIN ANALYZE, prod, LIMIT 50):
--
--   Seq Scan on agent_jobs  (Filter: workspace_id = $1)  → top-N heapsort of 22,655 rows
--   → 4,227 buffers, 38.8 ms.
--
-- The existing indexes can't serve it: agent_jobs_ws_status_idx leads (workspace_id, status,
-- created_at), so an ORDER BY created_at with NO status predicate can't walk it in sorted order —
-- the planner reads every row and sorts. A (workspace_id, created_at DESC) index lets the scan read
-- rows already in created_at order and stop after LIMIT+OFFSET, turning the full scan+sort into a
-- short index range read.
--
-- Also cleans up the COLD path of resolveDefaultWorkspaceId (brain-roadmap.ts): its
-- `ORDER BY created_at DESC LIMIT 1` currently costs ~1,445 buffers / 9 ms when the 5-min memo
-- misses; with this index it becomes a 1-row index scan.
--
-- Write cost is low: workspace_id + created_at are both immutable after insert, so status/heartbeat
-- UPDATEs never touch this index — it's one entry per INSERT on a ~22k-row table.
create index if not exists agent_jobs_ws_created_at_idx
  on public.agent_jobs (workspace_id, created_at desc);

comment on index public.agent_jobs_ws_created_at_idx is
  'Serves the workspace-scoped created_at-ordered read path (paginated recent-jobs list + resolveDefaultWorkspaceId cold path). ORDER BY created_at with no status predicate cannot use agent_jobs_ws_status_idx. agent-jobs-recent-list-idx.';
