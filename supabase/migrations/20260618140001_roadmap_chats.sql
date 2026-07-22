-- roadmap_chats: persist the Roadmap authoring chat (AuthoringChat.tsx) so an in-progress
-- conversation survives closing the modal / navigating away and can be resumed cross-device.
-- DB-backed companion to the in-memory React state. See
-- docs/brain/specs/authoring-chat-persistence.md (Phase 1).

create table if not exists public.roadmap_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid,
  -- null = a "New feature" chat not yet saved as a spec; set once a slug exists (refine / finalize).
  spec_slug text,
  title text,
  messages jsonb not null default '[]'::jsonb,   -- the [{role,content}] transcript
  status text not null default 'active',          -- active | finalized
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Resume list (recent per user) + the per-spec latest active lookup.
create index if not exists roadmap_chats_user_idx on public.roadmap_chats (workspace_id, user_id, updated_at desc);
create index if not exists roadmap_chats_slug_idx on public.roadmap_chats (workspace_id, spec_slug);

alter table public.roadmap_chats enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'roadmap_chats' and policyname = 'roadmap_chats_select') then
    create policy roadmap_chats_select on public.roadmap_chats for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'roadmap_chats' and policyname = 'roadmap_chats_service') then
    create policy roadmap_chats_service on public.roadmap_chats for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
