-- Empirical first-observed-at anchor for the Control Tower registered_not_firing grace
-- (control-tower-registered-not-firing-observed-anchor-grace, Phase 1).
--
-- The grace clock for registered_not_firing was anchored to the hand-edited
-- MonitoredLoop.registeredAt code constant + the cron's first scheduled firing at-or-after
-- that timestamp (control-tower-cron-grace-uses-next-firing-after-registration). When a
-- registeredAt is hand-edited BEFORE the cron actually shipped — fleet-spend-governor was
-- registered "2026-06-25T00:00:00Z" with cadence `10,40 * * * *`, so the computed first
-- firing rounds to 00:10 SAME day — the 90-min grace expires hours before the cron has
-- ever had a chance to fire, false-paging registered_not_firing the moment the deploy lands
-- (Control Tower signature `loop:fleet-spend-governor`).
--
-- The fix is an EMPIRICAL anchor: a deploy-SURVIVING per-loop record of when the snapshot
-- first SAW each loop registered. buildControlTowerSnapshot upserts (loop_id, now()) on
-- every tick with on-conflict-do-nothing, so the first observation wins and every subsequent
-- tick is a no-op. The grace then anchors to MAX(firstScheduledFiringMs, first_seen_at),
-- so a hand-edited pre-existence registeredAt can never shorten the grace below "we have
-- actually seen this loop registered for at least one full window."
--
-- Global infra (mirrors loop_heartbeats / loop_alerts / worker_heartbeats): RLS lets any
-- authenticated reader see it; only the service role writes.

create table if not exists public.monitored_loops_first_seen (
  loop_id text primary key,
  first_seen_at timestamptz not null default now()
);

alter table public.monitored_loops_first_seen enable row level security;

drop policy if exists "monitored_loops_first_seen_authenticated_read" on public.monitored_loops_first_seen;
create policy "monitored_loops_first_seen_authenticated_read"
  on public.monitored_loops_first_seen
  for select
  to authenticated
  using (true);
