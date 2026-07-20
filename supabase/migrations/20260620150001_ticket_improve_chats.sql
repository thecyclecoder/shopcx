-- ticket_improve_chats: the ticket-bound, resumable session behind the box-hosted Improve agent
-- (box-ticket-improve). One active session per ticket — opening the Improve tab loads-or-creates it.
-- A turn spawns one short-lived agent_jobs row (kind='ticket-improve') that resumes the box's Max
-- `claude -p` session (box_session_id); the markdown transcript here is the human-readable mirror +
-- cross-device resume. The approval-gated action plan the box proposes is parked in pending_plan
-- until the founder/CX manager approves it (executed server-side via the existing improve executors).
-- See docs/brain/specs/box-ticket-improve.md + docs/brain/tables/ticket_improve_chats.md.

create table if not exists public.ticket_improve_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid,
  -- the ticket this session is permanently bound to (auto ticket-binding — the human never states it)
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  -- the box `claude -p` session id; turn 1 starts fresh, later turns run `claude --resume <box_session_id>`
  box_session_id text,
  messages jsonb not null default '[]'::jsonb,   -- the [{role,content}] transcript (mirror of the box session)
  -- idle | thinking (a box turn is in flight) | error | awaiting_approval (a plan is parked in pending_plan)
  turn_status text not null default 'idle' check (turn_status in ('idle', 'thinking', 'error', 'awaiting_approval')),
  pending_plan jsonb,                             -- the typed action plan the box proposed, awaiting approval
  last_error text,
  status text not null default 'active' check (status in ('active', 'resolved')),  -- resolved once the plan closes the ticket
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One session per ticket (ticket-bound lifecycle). Load-or-create keys off this.
create unique index if not exists ticket_improve_chats_ticket_idx on public.ticket_improve_chats (ticket_id);
create index if not exists ticket_improve_chats_ws_idx on public.ticket_improve_chats (workspace_id, updated_at desc);

alter table public.ticket_improve_chats enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ticket_improve_chats' and policyname = 'ticket_improve_chats_select') then
    create policy ticket_improve_chats_select on public.ticket_improve_chats for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'ticket_improve_chats' and policyname = 'ticket_improve_chats_service') then
    create policy ticket_improve_chats_service on public.ticket_improve_chats for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
