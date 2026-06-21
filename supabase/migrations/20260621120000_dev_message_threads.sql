-- dev_message_threads: the founder-facing "Developer > Message Center" console
-- (docs/brain/specs/developer-message-center.md). A read-only "ask the box anything" chat that runs a
-- long-running, resumable `claude -p` Max session on the build box with the whole brain, the full repo,
-- read access to the prod DB, and WebSearch. Dedicated table (NOT riding roadmap_chats) because the
-- lifecycle differs: no finalize/spec_slug terminal state, but it DOES carry approval cards for any
-- proposed DB mutation / migration / spec handoff. Mirrors the proven roadmap_chats shape.
--   messages        — the [{role,content}] transcript.
--   box_session_id  — resumable `claude -p` Max session id; null until turn 1 runs.
--   turn_status     — idle | thinking | error. 'thinking' while a dev-ask job is in flight; the UI polls.
--   last_error      — failure reason surfaced when turn_status='error' (UI offers a retry).
--   pending_actions — gated approval cards: [{id,type,summary,cmd?,preview?,spec?,content?,queueBuild?,status,result?}].
--                     Reads are silent; every write/migration/spec handoff stops here until the owner approves.
-- 'dev-ask' is just a new agent_jobs.kind value (no CHECK on kind; claim_agent_job takes a dynamic
-- p_kinds array) so the worker's concurrency-1 dev-ask lane needs no further DB change.
create table if not exists public.dev_message_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid,
  title text,
  messages jsonb not null default '[]'::jsonb,            -- the [{role,content}] transcript
  box_session_id text,                                    -- resumable `claude -p` Max session id
  turn_status text not null default 'idle',               -- idle | thinking | error
  last_error text,
  pending_actions jsonb not null default '[]'::jsonb,     -- gated approval cards
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Resume list (recent per user, newest first).
create index if not exists dev_message_threads_user_idx
  on public.dev_message_threads (workspace_id, user_id, updated_at desc);

alter table public.dev_message_threads enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'dev_message_threads' and policyname = 'dev_message_threads_select') then
    create policy dev_message_threads_select on public.dev_message_threads for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'dev_message_threads' and policyname = 'dev_message_threads_service') then
    create policy dev_message_threads_service on public.dev_message_threads for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
