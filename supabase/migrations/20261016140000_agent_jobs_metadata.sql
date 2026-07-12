-- agent_jobs.metadata — structured side-channel bag on agent_jobs, mirroring the
-- spec_phases.metadata / spec_timecard_events.metadata convention (jsonb not null default '{}').
--
-- Code-ahead-of-schema drift: the rail-escalation path (a build/director hitting an out-of-leash
-- rail creates a "synthetic agent_jobs target" to escalate) writes `agent_jobs.metadata`, but no
-- migration ever added the column. The insert failed with `Could not find the 'metadata' column of
-- 'agent_jobs' in the schema cache`, breaking rail-escalation for EVERY function (growth, cs,
-- logistics observed 2026-07-12) — a director/build that hit a rail could not escalate, so it
-- parked/looped instead. Applied out-of-band via the pooler 2026-07-12 to unwedge the lane; this
-- migration records it. Additive + idempotent (ADD COLUMN IF NOT EXISTS; existing rows get '{}').
alter table public.agent_jobs
  add column if not exists metadata jsonb not null default '{}'::jsonb;
