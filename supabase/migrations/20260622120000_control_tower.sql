-- Control Tower — Phase 1: liveness + alerting (see docs/brain/specs/control-tower.md).
--
-- Two tables let every autonomous loop watch itself:
--   loop_heartbeats — every monitored loop writes ONE row at the END of each run
--     (crons + each box agent-kind runner). The box worker itself keeps using
--     worker_heartbeats (its ~5s poll beat); this table is for the crons + agent
--     kinds whose "run" is discrete. The control-tower-monitor cron reads the
--     latest beat per loop to decide liveness / cron-freshness.
--   loop_alerts — the de-duped incident log: one OPEN alert per loop at a time
--     (partial unique index), auto-resolved by the monitor on the next healthy
--     evaluation. A newly-opened alert pages the owners via the Slack ops path.
--
-- Both are GLOBAL infra (not workspace-scoped), exactly like worker_heartbeats:
-- the box + crons are one shared fleet. RLS: any authenticated user reads;
-- service role does all writes (the worker + Inngest hold the creds).

-- ── loop_heartbeats ──────────────────────────────────────────────────────────
create table if not exists public.loop_heartbeats (
  id uuid primary key default gen_random_uuid(),
  -- the monitored loop's stable id: a cron's inngest function id
  -- (e.g. 'triage-escalations-cron') or 'agent:<kind>' for a box agent-kind run.
  loop_id text not null,
  -- 'cron' | 'agent-kind' — what kind of loop emitted this (matches the registry).
  kind text not null,
  ran_at timestamptz not null default now(),
  -- did the run do its job? false ⇒ it threw / reported a failure.
  ok boolean not null default true,
  -- what it produced this run (counts/summary): { enqueued, workspaces, status, … }.
  produced jsonb,
  detail text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists loop_heartbeats_loop_ran_idx
  on public.loop_heartbeats (loop_id, ran_at desc);

alter table public.loop_heartbeats enable row level security;
drop policy if exists loop_heartbeats_select on public.loop_heartbeats;
create policy loop_heartbeats_select on public.loop_heartbeats
  for select to authenticated using (auth.uid() is not null);
drop policy if exists loop_heartbeats_service on public.loop_heartbeats;
create policy loop_heartbeats_service on public.loop_heartbeats
  for all to service_role using (true) with check (true);

-- ── loop_alerts ──────────────────────────────────────────────────────────────
create table if not exists public.loop_alerts (
  id uuid primary key default gen_random_uuid(),
  loop_id text not null,
  kind text,
  -- which check fired: 'liveness' | 'cron_freshness' | 'stuck_jobs'.
  reason text not null,
  detail text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- One OPEN incident per loop at a time — the de-dupe spine (the monitor upserts
-- against this: insert+page on first sight, bump last_seen_at on repeat).
create unique index if not exists loop_alerts_one_open_per_loop
  on public.loop_alerts (loop_id) where status = 'open';
create index if not exists loop_alerts_status_opened_idx
  on public.loop_alerts (status, opened_at desc);

alter table public.loop_alerts enable row level security;
drop policy if exists loop_alerts_select on public.loop_alerts;
create policy loop_alerts_select on public.loop_alerts
  for select to authenticated using (auth.uid() is not null);
drop policy if exists loop_alerts_service on public.loop_alerts;
create policy loop_alerts_service on public.loop_alerts
  for all to service_role using (true) with check (true);
