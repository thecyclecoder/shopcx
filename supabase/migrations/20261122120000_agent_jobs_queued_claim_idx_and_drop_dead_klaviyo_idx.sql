-- agent-jobs-read-amplification — cut the box poll loop's full-index scans, and drop one dead index.
--
-- Context: Supabase's 2026-07-21 health check flagged public.agent_jobs for 600,246 sequential scans
-- and ~8.9 billion tuples read against a 22k-row table. Measured plans (EXPLAIN ANALYZE, prod):
--
--   SELECT DISTINCT kind FROM agent_jobs WHERE status IN ('queued','queued_resume')
--     → Index Scan using agent_jobs_ws_status_idx, Index Cond on `status` ONLY. 277 buffers, 3.1 ms.
--   SELECT id FROM agent_jobs WHERE status IN ('queued','queued_resume')
--     AND (claimed_at IS NULL OR claimed_at <= now()) LIMIT 1
--     → same shape. 277 buffers, 3.1 ms.
--
-- Both are the box poll loop's every-5s reads (src/lib/pg-pool.ts `queuedAgentJobKinds` +
-- `hasClaimableAgentJob`), ~400k calls combined. Neither constrains `workspace_id`, so the existing
-- agent_jobs_ws_status_idx (workspace_id, status, created_at DESC) can only be scanned in full — its
-- leading column is unconstrained. A partial index whose predicate matches the queries' INLINE literals
-- turns each into a scan of a handful of rows.
--
-- Why this is cheap to carry: the predicate covers ONLY queued/queued_resume rows — a tiny, transient
-- slice (0 such rows at authoring time; the queue drains continuously). Rows are indexed as they enter
-- the queue and de-indexed as they leave, so the write overhead on the completed/merged/cancelled bulk
-- of the table (99%+ of rows) is zero.
--
-- `kind` leads because the DISTINCT-kind probe is the higher-call query and can answer from the index
-- alone; the claimable probe scans the same small partial index and filters claimed_at.
create index if not exists agent_jobs_queued_claim_idx
  on public.agent_jobs (kind, claimed_at)
  where status in ('queued', 'queued_resume');

comment on index public.agent_jobs_queued_claim_idx is
  'Partial index for the box poll loop queued-row probes (pg-pool queuedAgentJobKinds + hasClaimableAgentJob). Predicate matches the inline status literals in those queries; covers only the transient queued slice.';

-- Dead index: klaviyo_profile_staging_customer_idx (9952 kB, idx_scan = 0 lifetime).
-- Built for a one-time Klaviyo profile-staging import and never read since (CEO confirmed 2026-07-21).
-- Not constraint-backed (plain btree, not primary/unique), so dropping it removes no invariant — it is
-- pure write + vacuum + backup overhead on a staging table. Reversible: recreate with the same
-- definition if a future import needs it.
drop index if exists public.klaviyo_profile_staging_customer_idx;
