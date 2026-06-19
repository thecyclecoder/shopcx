-- worker_heartbeats: lightweight liveness/visibility row written by the box build worker
-- (scripts/builder-worker.ts) each poll tick. Lets the dashboard answer "is the box behind?"
-- (running SHA + last poll) and "is it healthy?" without SSH. Singleton per box (id, default 'box').
-- See docs/brain/specs/worker-self-update.md (Phase 3) + docs/brain/tables/worker_heartbeats.md.

create table if not exists public.worker_heartbeats (
  id text primary key default 'box',          -- one row per box (supports multiple boxes later)
  running_sha text,                            -- short SHA the worker process is running
  status text not null default 'healthy',      -- healthy | updating | needs_attention
  active_builds integer not null default 0,    -- lanes busy at the last tick (0 = idle)
  detail text,                                 -- last note: self-update from→to, crash-loop reason, …
  started_at timestamptz,                       -- when this worker process booted
  last_poll_at timestamptz,                     -- heartbeat: last completed poll tick
  updated_at timestamptz not null default now()
);

alter table public.worker_heartbeats enable row level security;

do $$ begin
  -- Box infra is global (not workspace-scoped); any authenticated member may read the health row.
  if not exists (select 1 from pg_policies where tablename = 'worker_heartbeats' and policyname = 'worker_heartbeats_select') then
    create policy worker_heartbeats_select on public.worker_heartbeats for select
      using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'worker_heartbeats' and policyname = 'worker_heartbeats_service') then
    create policy worker_heartbeats_service on public.worker_heartbeats for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
