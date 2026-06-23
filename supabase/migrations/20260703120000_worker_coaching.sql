-- worker_coaching_loop Phase 1 — the DevOps Director coaches its workers (docs/brain/specs/worker-coaching-loop.md).
--
-- Two tables that turn "coaching = a data write, not a deploy" into reality:
--
--   worker_instructions  — per-worker, versioned guidance that is APPENDED to the worker's base prompt
--                          at runtime (every run). When a director spots a worker making the same class
--                          of mistake N times, it writes a new ACTIVE instruction here (the "learning");
--                          the worker picks it up on its very next run with no code change. Mirrors the
--                          grader_prompts versioned-calibration shape + the storefront lever-importance
--                          memory (a learned store loaded into a prompt at runtime). Coaching is
--                          reversible guidance — every amendment is versioned (status active｜superseded
--                          ｜reverted) + revertible.
--
--   worker_coaching_log  — the director→worker COMMUNICATION log (a real, visible message): one row per
--                          coaching act, with the old→new instruction diff, the triggering pattern, the
--                          activity rows that prompted it, the attempt count, the post-coaching re-check
--                          status, and the #directors board post it produced. Surfaced on the worker's
--                          profile page (its coaching history).
--
-- north-star chain: CEO → director → worker. The WRITE PATH is director-gated — `coached_by` is the
-- SUPERVISING director's function slug (never the worker), and RLS only lets the service role write, so
-- a worker (a read-only `claude -p` box session) can never edit its own instructions. `worker_kind` is
-- the agent_jobs kind that identifies the worker (e.g. 'repair', 'regression'). `error_class` is the
-- supersede/dedup key — the class of mistake the guidance addresses (e.g. 'dismiss-own-api-5xx-as-foreign').
--
-- Workspace-scoped (mirrors director_activity / director_messages). RLS: any authenticated user reads
-- (the profile + history surfaces are owner-gated above the DB); service role does all writes.

create table if not exists public.worker_instructions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the agent_jobs kind that identifies the worker the guidance is for (e.g. 'repair', 'regression').
  worker_kind text not null,
  -- the class of mistake this guidance addresses — the supersede/dedup key within a worker.
  error_class text not null,
  -- the learning itself: "when you see X, do Y instead — because Z" (appended to the worker's prompt).
  guidance text not null,
  -- the human-readable pattern that triggered the coaching (the repeated mistake).
  triggering_pattern text not null default '',
  -- the "why" behind the guidance (the Z).
  reasoning text not null default '',
  -- versioning: active guidance is loaded into the prompt; a newer version supersedes; a revert flips it.
  status text not null default 'active', -- active｜superseded｜reverted (open vocabulary, no CHECK)
  version int not null default 1,
  supersedes_id uuid references public.worker_instructions(id) on delete set null,
  -- director-gated provenance: the SUPERVISING director's function slug (never the worker itself).
  coached_by text not null,
  -- the director_decision_grade that prompted it (director-loop-grading), null until that store exists.
  source_grade_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The runtime load: a worker's ACTIVE guidance, newest-first (appended to its prompt every run).
create index if not exists worker_instructions_load_idx
  on public.worker_instructions (workspace_id, worker_kind, status, created_at desc);
-- Supersede/dedup lookup by class.
create index if not exists worker_instructions_class_idx
  on public.worker_instructions (worker_kind, error_class);

alter table public.worker_instructions enable row level security;
drop policy if exists worker_instructions_select on public.worker_instructions;
create policy worker_instructions_select on public.worker_instructions
  for select to authenticated using (auth.uid() is not null);
drop policy if exists worker_instructions_service on public.worker_instructions;
create policy worker_instructions_service on public.worker_instructions
  for all to service_role using (true) with check (true);

create table if not exists public.worker_coaching_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the worker the message was sent TO (the recipient).
  worker_kind text not null,
  -- the director that sent it (the SUPERVISING director's function slug).
  coached_by text not null,
  -- the class of mistake + the triggering pattern this coaching addressed.
  error_class text not null,
  triggering_pattern text not null default '',
  -- the old→new instruction diff (old null on a first coaching for the class).
  old_instruction text,
  new_instruction text not null default '',
  reasoning text not null default '',
  -- the worker_instructions amendment this message logged (null for a code-bug route / escalation).
  instruction_id uuid references public.worker_instructions(id) on delete set null,
  -- the director_activity rows (the repeated mistakes) that prompted it.
  source_activity_ids jsonb not null default '[]'::jsonb,
  -- which coaching attempt this is for the (worker, class) — drives the escalate-after-N guard.
  attempt int not null default 1,
  -- what the director did: coaching (amend) ｜ code-bug-route (→ Repair) ｜ escalation (→ CEO).
  kind text not null default 'coaching',
  -- post-coaching re-check: did the class recur on the worker's next runs? pending｜stuck｜recurred.
  recheck_status text not null default 'pending',
  rechecked_at timestamptz,
  -- the #directors board post this coaching produced (the visible message).
  board_message_id uuid references public.director_messages(id) on delete set null,
  created_at timestamptz not null default now()
);

-- The profile-page read: a worker's coaching history newest-first.
create index if not exists worker_coaching_log_worker_idx
  on public.worker_coaching_log (workspace_id, worker_kind, created_at desc);
-- Per-class lookup (attempt counting + re-check).
create index if not exists worker_coaching_log_class_idx
  on public.worker_coaching_log (worker_kind, error_class, created_at desc);

alter table public.worker_coaching_log enable row level security;
drop policy if exists worker_coaching_log_select on public.worker_coaching_log;
create policy worker_coaching_log_select on public.worker_coaching_log
  for select to authenticated using (auth.uid() is not null);
drop policy if exists worker_coaching_log_service on public.worker_coaching_log;
create policy worker_coaching_log_service on public.worker_coaching_log
  for all to service_role using (true) with check (true);
