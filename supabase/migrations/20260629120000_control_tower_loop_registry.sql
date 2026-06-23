-- control_tower_loop_registry — per-loop "first time the monitor observed this loop registered"
-- (control-tower-registered-not-firing-new-cron-grace spec).
--
-- The registered_not_firing guard in evalCron (monitor.ts) flips a registered cron RED when it has
-- 0 heartbeats EVER and the watchdog has been continuously alive (monitorUptimeMs) longer than the
-- cron's cadence+grace window. monitorUptimeMs is the Control Tower watchdog's OWN uptime — NOT how
-- long the implicated cron has existed. A cron added AFTER the watchdog (the common case — the box
-- has been up for days) inherits the watchdog's long uptime and trips the guard the moment it's
-- registered, hours before its first scheduled tick can fire (the loop:storefront-lever-decay-cron
-- false positive: alert opened 9h before any fire was possible).
--
-- This table anchors the grace window to THIS loop instead of the watchdog: the monitor records
-- first_observed_at the first time it sees a loop id (insert-if-absent, never updated), and the guard
-- gates on min(monitorUptimeMs, now - first_observed_at) > window. A newly-deployed cron therefore
-- always gets a full cadence+grace window before it can flip red, while a long-registered cron whose
-- Inngest schedule genuinely isn't active still pages once its first_observed age clears the window.
--
-- Global (loops are not workspace-scoped — same as loop_heartbeats / loop_alerts). One row per loop_id.
-- RLS: any authenticated user reads; service role does all writes (the monitor runs service-role).

create table if not exists public.control_tower_loop_registry (
  -- the monitored loop's stable id (matches loop_heartbeats.loop_id / the registry entry).
  loop_id text primary key,
  -- 'cron' | 'agent-kind' | … — what kind of loop this is (matches the registry), for context.
  kind text,
  -- the first time the Control Tower monitor observed this loop id registered. Written once on first
  -- sight (insert-if-absent) and never updated, so it's a stable lower bound on the loop's age that
  -- SURVIVES box self-update/restart — the deploy-independent anchor for the registered_not_firing grace.
  first_observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.control_tower_loop_registry enable row level security;
drop policy if exists control_tower_loop_registry_select on public.control_tower_loop_registry;
create policy control_tower_loop_registry_select on public.control_tower_loop_registry
  for select to authenticated using (auth.uid() is not null);
drop policy if exists control_tower_loop_registry_service on public.control_tower_loop_registry;
create policy control_tower_loop_registry_service on public.control_tower_loop_registry
  for all to service_role using (true) with check (true);
