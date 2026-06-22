-- build-all-phases-chain Phase 1: agent_jobs grows a `chain_phases` flag. A "Build all" tap queues the
-- spec's FIRST ⏳ phase with chain_phases=true; when that phase's PR merges (auto-ship-pipeline auto-merge),
-- the post-merge step (reconcileMergedJobs → queueNextChainedPhase) queues the NEXT ⏳ phase, also
-- chain_phases=true, and so on until every phase is ✅ — no owner clicks between phases. A failed /
-- needs_approval phase never reaches `merged`, so the chain naturally stops/pauses there.
-- Default false ⇒ existing single-phase / non-chained builds are unaffected.
-- See docs/brain/specs/build-all-phases-chain.md.
alter table public.agent_jobs
  add column if not exists chain_phases boolean not null default false;
