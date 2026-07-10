-- max_watch_windows — the 48h "be Max for 48h" watch clock (CEO 2026-07-10). One row per watch window;
-- the hourly max-watch cron enqueues a god-mode watch turn while now() < ends_at, then flips status=ended,
-- disarms the god-mode session, and the final turn synthesizes Max's spec. The director-training status
-- skill reads the active window + the god-mode session transcript to report progress. See
-- docs/brain/lifecycles/max-watch + libraries/max-watch-cadence.
create table if not exists public.max_watch_windows (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  status               text not null default 'active' check (status in ('active','ended')),
  started_at           timestamptz not null default now(),
  ends_at              timestamptz not null,
  god_mode_session_id  uuid,               -- the armed god-mode session the watch drives (re-armed hourly)
  agents               text[] not null default '{}',   -- e.g. {media-buyer, ad-creative}
  last_turn_at         timestamptz,        -- when the cron last enqueued a watch turn
  turns_enqueued       int not null default 0,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- At most one active window per workspace (the watch owns one god-mode session at a time).
create unique index if not exists max_watch_windows_one_active_idx
  on public.max_watch_windows (workspace_id) where status = 'active';

alter table public.max_watch_windows enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='max_watch_windows' and policyname='max_watch_windows_service_all') then
    create policy max_watch_windows_service_all on public.max_watch_windows for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='max_watch_windows' and policyname='max_watch_windows_member_select') then
    create policy max_watch_windows_member_select on public.max_watch_windows for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = max_watch_windows.workspace_id and m.user_id = auth.uid()));
  end if;
end $$;
