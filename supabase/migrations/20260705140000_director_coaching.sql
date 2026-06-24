-- worker-grading-and-director-management Phase 7 — CEO↔Director coaching, conversational.
-- The cascade's TOP rung: the CEO coaches the Platform/DevOps Director (Ada) the same way she coaches
-- her workers (worker_instructions / worker_coaching_log), one level UP. Three tables:
--
--   director_coach_threads  — the resumable Max CHAT thread (mirror dev_message_threads): the CEO asks
--                             "why haven't you built spec X?", a box `claude -p` session explains from
--                             her real state read-only, the CEO coaches, and a proposed `coaching` card
--                             stops at an approval gate. The thread is the conversation.
--
--   director_instructions   — per-director, versioned guidance APPENDED to the director's decision
--                             prompts at runtime (mirror worker_instructions one level up). CEO-gated
--                             (`coached_by`), so coaching changes what she does autonomously with no deploy.
--
--   director_coaching_log   — the CEO→director communication log (mirror worker_coaching_log): one row
--                             per coaching act, surfaced on her profile as her coaching history.
--
-- north-star chain: CEO → director → worker. The WRITE PATH is CEO-gated — `coached_by` is the
-- coaching seat ('ceo'), never the director itself, and RLS is service-role-write-only (the box session
-- runs read-only and can't edit her own instructions). Workspace-scoped. RLS: authenticated reads
-- (profile/chat are owner-gated above the DB), service-role writes — mirror worker_coaching.

-- ── director_coach_threads — the resumable coaching CHAT (mirror dev_message_threads) ──────────────
create table if not exists public.director_coach_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid,
  -- the director this thread coaches (the function slug, e.g. 'platform').
  director_function text not null default 'platform',
  title text,
  -- [{"role":"user"|"assistant","content":"..."}] — the conversation.
  messages jsonb not null default '[]'::jsonb,
  -- the resumable `claude -p` session id (null until turn 1); the box --resumes it each turn.
  box_session_id text,
  -- per-turn lifecycle: idle → thinking → idle (reply) | error.
  turn_status text not null default 'idle',
  last_error text,
  -- gated cards the box proposes: a `coaching` amendment or a `spec` handoff (never executed by the model).
  pending_actions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists director_coach_threads_user_idx
  on public.director_coach_threads (workspace_id, user_id, updated_at desc);

alter table public.director_coach_threads enable row level security;
drop policy if exists director_coach_threads_select on public.director_coach_threads;
create policy director_coach_threads_select on public.director_coach_threads
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_coach_threads_service on public.director_coach_threads;
create policy director_coach_threads_service on public.director_coach_threads
  for all to service_role using (true) with check (true);

-- ── director_instructions — the runtime guidance store (mirror worker_instructions) ────────────────
create table if not exists public.director_instructions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the director the guidance is for (function slug, e.g. 'platform').
  director_function text not null,
  -- the class of decision this guidance addresses — the supersede/dedup key within a director.
  error_class text not null,
  -- the learning itself: "when you see X, do Y instead — because Z" (appended to her decision prompts).
  guidance text not null,
  triggering_pattern text not null default '',
  reasoning text not null default '',
  status text not null default 'active', -- active｜superseded｜reverted (open vocabulary, no CHECK)
  version int not null default 1,
  supersedes_id uuid references public.director_instructions(id) on delete set null,
  -- CEO-gated provenance: the coaching seat ('ceo'), never the director itself.
  coached_by text not null default 'ceo',
  -- the coaching thread this learning was distilled from, if any.
  source_thread_id uuid references public.director_coach_threads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists director_instructions_load_idx
  on public.director_instructions (workspace_id, director_function, status, created_at desc);
create index if not exists director_instructions_class_idx
  on public.director_instructions (director_function, error_class);

alter table public.director_instructions enable row level security;
drop policy if exists director_instructions_select on public.director_instructions;
create policy director_instructions_select on public.director_instructions
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_instructions_service on public.director_instructions;
create policy director_instructions_service on public.director_instructions
  for all to service_role using (true) with check (true);

-- ── director_coaching_log — the CEO→director communication log (mirror worker_coaching_log) ─────────
create table if not exists public.director_coaching_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the director the message was sent TO (the recipient function slug).
  director_function text not null,
  -- who coached (the seat — 'ceo').
  coached_by text not null default 'ceo',
  error_class text not null,
  triggering_pattern text not null default '',
  old_instruction text,
  new_instruction text not null default '',
  reasoning text not null default '',
  instruction_id uuid references public.director_instructions(id) on delete set null,
  source_thread_id uuid references public.director_coach_threads(id) on delete set null,
  attempt int not null default 1,
  kind text not null default 'coaching', -- coaching (open vocabulary)
  created_at timestamptz not null default now()
);
create index if not exists director_coaching_log_dir_idx
  on public.director_coaching_log (workspace_id, director_function, created_at desc);
create index if not exists director_coaching_log_class_idx
  on public.director_coaching_log (director_function, error_class, created_at desc);

alter table public.director_coaching_log enable row level security;
drop policy if exists director_coaching_log_select on public.director_coaching_log;
create policy director_coaching_log_select on public.director_coaching_log
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_coaching_log_service on public.director_coaching_log;
create policy director_coaching_log_service on public.director_coaching_log
  for all to service_role using (true) with check (true);
