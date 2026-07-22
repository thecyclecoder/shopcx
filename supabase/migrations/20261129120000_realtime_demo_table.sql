-- realtime-demo — a tiny, self-contained table for verifying Supabase Realtime (Postgres Changes)
-- end-to-end: DB write → WAL → Realtime → browser subscription → live UI update, with zero polling.
--
-- Purpose is demonstration only (the /dashboard/developer/realtime-test panel subscribes to it). It is
-- deliberately NOT wired to any production flow — a service-role UPDATE to a row here should appear in an
-- open dashboard within a few hundred ms, proving the push pattern before we adopt it for real views
-- (box session steps, roadmap board, etc.).
create table if not exists public.realtime_demo (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label        text not null default 'demo',
  tick         integer not null default 0,
  note         text,
  updated_at   timestamptz not null default now()
);

alter table public.realtime_demo enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'realtime_demo' and policyname = 'realtime_demo_select') then
    create policy realtime_demo_select on public.realtime_demo for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'realtime_demo' and policyname = 'realtime_demo_service') then
    create policy realtime_demo_service on public.realtime_demo for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- Add to the supabase_realtime publication so Postgres Changes streams row events to subscribers.
-- Realtime respects RLS per-subscriber (the realtime_demo_select policy above), so a browser only
-- receives its own workspace's changes. Guarded — re-adding a table already in the publication errors.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'realtime_demo'
  ) then
    alter publication supabase_realtime add table public.realtime_demo;
  end if;
end $$;

-- Default replica identity (PK) is sufficient: INSERT/UPDATE events carry the full NEW row, which is all
-- the demo panel renders. (FULL replica identity would only be needed to receive OLD values on
-- UPDATE/DELETE, which this demo doesn't use.)

-- Seed one row for the single-tenant workspace so the panel has something to show on first load.
-- Idempotent: only seeds when the table is empty (there is no natural unique key to ON CONFLICT on,
-- so a not-exists guard keeps a migration re-apply from inserting a duplicate seed row).
insert into public.realtime_demo (workspace_id, label, tick, note)
select id, 'demo', 0, 'waiting for a change…'
from public.workspaces
where not exists (select 1 from public.realtime_demo)
order by created_at asc
limit 1;
