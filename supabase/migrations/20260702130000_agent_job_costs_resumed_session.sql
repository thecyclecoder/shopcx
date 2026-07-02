-- chained-phase-session-resume Phase 2 — attribute each metered turn as RESUMED-from-a-prior-session or
-- FRESH so the savings are provable in the DB. A resumed turn should show `cache_read_tokens` materially
-- exceeding fresh `input_tokens` (the prior transcript served from cache ~0.1x); a fresh turn does not.
-- Marker column + composite index so a comparison query (`select ... where resumed_session = true`) stays
-- cheap. Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS).

alter table public.agent_job_costs
  add column if not exists resumed_session boolean not null default false;

create index if not exists agent_job_costs_resumed_idx
  on public.agent_job_costs (resumed_session, created_at desc);
