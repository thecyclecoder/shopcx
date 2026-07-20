-- director_activity — the timestamped action log every director (and its workers) writes a row to on
-- each action it takes (see docs/brain/goals/devops-director.md). That single log is the substrate for
-- (1) the autonomous-approval AUDIT HISTORY, (2) the gamified #directors BOARD posts, and (3) the EOD
-- RECAP (a read over today's rows — never hand-maintained).
--
-- The FIRST concrete writer is the Regression Agent (docs/brain/specs/regression-agent.md, a worker the
-- Platform/DevOps Director supervises): every detect / dismiss / author / escalate action it takes
-- writes one row here (action_kind ∈ detected_regression｜dismissed_regression｜authored_fix｜escalated).
-- The live directors (M4+) write the same shape (approved_migration, fixed_bug, escorted_goal, …).
--
-- `director_function` = the function slug whose objective owns the action (e.g. 'platform'); for a
-- worker action it is the SUPERVISING director's function (the worker answers to the director — the
-- north-star chain CEO → director → worker). `spec_slug` is the spec the action touched (null for a
-- non-spec action). `reason` is the plain-text "why". `metadata` carries structured context
-- (job_id, signature, the failing checks, attempt count, …).
--
-- Workspace-scoped (mirrors director_messages / spec_card_state). RLS: any authenticated user reads
-- (the board + recap surfaces are owner-gated above the DB); service role does all writes.

create table if not exists public.director_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the function slug whose objective owns the action (a worker action carries its SUPERVISING director).
  director_function text not null,
  -- what the director/worker did. Open vocabulary (no CHECK — new action kinds land without a migration);
  -- regression-agent emits: detected_regression｜dismissed_regression｜authored_fix｜escalated.
  action_kind text not null,
  -- the spec the action touched (null for a non-spec action).
  spec_slug text,
  -- the plain-text "why" — the reasoning the recap/audit reads back.
  reason text not null default '',
  -- structured per-action context: { job_id?, signature?, failing?, attempt?, verdict?, ... }.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- The recap/audit read: a workspace's activity newest-first (the EOD recap filters by created_at >= today).
create index if not exists director_activity_ws_created_idx
  on public.director_activity (workspace_id, created_at desc);
-- Per-director and per-spec audit slices.
create index if not exists director_activity_function_idx
  on public.director_activity (director_function, created_at desc);
create index if not exists director_activity_spec_idx
  on public.director_activity (spec_slug);

alter table public.director_activity enable row level security;
drop policy if exists director_activity_select on public.director_activity;
create policy director_activity_select on public.director_activity
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_activity_service on public.director_activity;
create policy director_activity_service on public.director_activity
  for all to service_role using (true) with check (true);
