-- worker_controls — soft-control flags the build box polls each tick (queue-restart / drain-for-update).
-- "Queue restart": stop CLAIMING new work so in-flight lanes finish, the box reaches idle, its idle
-- self-update fires (SHA advances), and the boot of the fresh worker clears the flag. Lets the CEO stage a
-- restart without force-killing in-flight builds — new builds queue until the box is current, then resume.
create table if not exists public.worker_controls (
  box_id text primary key,
  drain_for_update boolean not null default false,
  requested_at_sha text,        -- the box SHA when drain was requested; boot clears the flag once HEAD != this
  requested_by text,            -- display name / email of who pressed it (audit)
  requested_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The singleton row for the one box (WORKER_BOX_ID default 'box').
insert into public.worker_controls (box_id) values ('box') on conflict (box_id) do nothing;

alter table public.worker_controls enable row level security;
create policy worker_controls_service on public.worker_controls for all to service_role using (true) with check (true);
create policy worker_controls_read on public.worker_controls for select to authenticated using (true);
