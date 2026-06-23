-- Director-decision grade store + calibration rubric — the CEO's supervisory feedback signal
-- (docs/brain/specs/director-loop-grading.md, Phase 2; M5 of the devops-director goal).
--
-- One level up the org chart from the shipped storefront campaign-grading loop
-- (storefront_campaign_grades + storefront_grader_prompts): there the Head-of-Growth grades the
-- Optimizer's campaigns; here the CEO grades the Platform/DevOps Director's CALLS — was the
-- auto-approval sound, did the escorted goal land clean — 1–10, and those grades train it +
-- tighten/loosen the leash (Phase 4). This migration is just the store + rubric (Phase 2); the
-- LLM grader that writes the rows is director-grader.ts (Phase 3).
--
-- Two tables (mirroring the storefront/acquisition grader pattern):
--   director_decision_grades — one row per graded director CALL. A call is one of two DIMENSIONS:
--       'auto-approval' — keyed to the approval_decisions row the director auto-approved.
--       'goal-escort'   — keyed to the goal_slug + milestone the director escorted (the goal lives
--                         in docs/brain/goals, so goal_slug has no FK).
--     grade (1–10) + reasoning, graded_by ∈ agent|human, and the human override provenance.
--   director_grader_prompts — the human-approved calibration store (status ∈ proposed|approved|
--                         rejected|archived, derived_from_*) so the CEO corrects the grader's
--                         scoring on edge cases — same arc as grader_prompts.
--
-- Safety invariants baked in here (docs/brain/specs/director-loop-grading.md § Safety):
--   • grade CHECK in [1,10]; graded_by CHECK ∈ agent|human; status CHECK ∈ proposed|approved|
--     rejected|archived on the calibration store.
--   • dimension CHECK ∈ auto-approval|goal-escort, with a polymorphic-key CHECK: an auto-approval
--     row carries approval_decision_id (no goal_slug); a goal-escort row carries goal_slug+milestone
--     (no approval_decision_id) — never both, never neither.
--   • Idempotent grading — one row per call per dimension: a partial UNIQUE on approval_decision_id
--     (auto-approval) and a partial UNIQUE on (workspace_id, goal_slug, milestone) (goal-escort).
--     A re-run UPDATEs in place, never inserts a duplicate.
--   • Human-overridable — graded_by flips to 'human' + overridden_by records who; the agent never
--     re-writes a human grade.
-- RLS mirrors approval_decisions (the ledger this grades): any authenticated user SELECTs (the
-- Agents-hub report is owner-gated above the DB), service-role does all writes.

-- ── director_decision_grades — one row per graded director call ────────────────
create table if not exists public.director_decision_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Which kind of director call this grade scores.
  --   auto-approval — the director auto-approved a routed Approval Request (within the leash).
  --   goal-escort   — the director escorted an approved goal/milestone to landing.
  dimension text not null check (dimension in ('auto-approval', 'goal-escort')),

  -- For dimension='auto-approval': the approval_decisions row the director auto-approved.
  approval_decision_id uuid references public.approval_decisions(id) on delete cascade,
  -- For dimension='goal-escort': the goal + milestone the director escorted. The goal lives in
  -- docs/brain/goals (no DB table), so goal_slug carries no FK.
  goal_slug text,
  milestone text,

  -- The 1–10 grade + the grader's stated "why" (the auditable reasoning).
  grade integer check (grade between 1 and 10),
  reasoning text,

  -- ── Supervision (the human-overridable gate) ─────────────────────────────────
  -- 'agent' = the grader scored it; 'human' = the CEO overrode.
  graded_by text not null default 'agent' check (graded_by in ('agent', 'human')),
  -- The workspace member who overrode (nullable until an override happens).
  overridden_by uuid references auth.users(id) on delete set null,
  override_reason text,
  overridden_at timestamptz,

  -- ── Model / cost accounting (mirror storefront_campaign_grades) ──────────────
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cost_cents numeric(10, 4) default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Polymorphic key: exactly one of (approval_decision_id) | (goal_slug+milestone), matched to the
  -- dimension — never both, never neither.
  constraint director_decision_grades_key_shape check (
    (dimension = 'auto-approval' and approval_decision_id is not null and goal_slug is null and milestone is null)
    or (dimension = 'goal-escort' and approval_decision_id is null and goal_slug is not null and milestone is not null)
  )
);

-- Idempotent grading — one row per auto-approval decision.
create unique index if not exists director_decision_grades_approval_uniq
  on public.director_decision_grades (approval_decision_id)
  where approval_decision_id is not null;
-- Idempotent grading — one row per escorted goal milestone.
create unique index if not exists director_decision_grades_goal_uniq
  on public.director_decision_grades (workspace_id, goal_slug, milestone)
  where dimension = 'goal-escort';

create index if not exists director_decision_grades_ws_idx
  on public.director_decision_grades (workspace_id, created_at desc);
-- Per-dimension report + trend lookup (Phase 4: per-period grades by category).
create index if not exists director_decision_grades_dimension_idx
  on public.director_decision_grades (workspace_id, dimension, created_at desc);

-- ── director_grader_prompts — the calibration store (mirror grader_prompts) ────
create table if not exists public.director_grader_prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  title text not null,
  content text not null,

  -- 'proposed' (waiting for CEO review) | 'approved' (injected into the grader prompt)
  -- | 'rejected' | 'archived'. Only 'approved' rules calibrate the grader.
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'archived')),

  -- Provenance — born from an override on a grade (a large grade gap → a proposed rule).
  derived_from_decision_id uuid references public.approval_decisions(id) on delete set null,
  derived_from_grade_id uuid references public.director_decision_grades(id) on delete set null,
  proposed_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,

  sort_order integer default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists director_grader_prompts_ws_status_idx
  on public.director_grader_prompts (workspace_id, status);

-- ── RLS — authenticated SELECT, service-role write (mirror approval_decisions) ──
alter table public.director_decision_grades enable row level security;
drop policy if exists director_decision_grades_select on public.director_decision_grades;
create policy director_decision_grades_select on public.director_decision_grades
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_decision_grades_service on public.director_decision_grades;
create policy director_decision_grades_service on public.director_decision_grades
  for all to service_role using (true) with check (true);

alter table public.director_grader_prompts enable row level security;
drop policy if exists director_grader_prompts_select on public.director_grader_prompts;
create policy director_grader_prompts_select on public.director_grader_prompts
  for select to authenticated using (auth.uid() is not null);
drop policy if exists director_grader_prompts_service on public.director_grader_prompts;
create policy director_grader_prompts_service on public.director_grader_prompts
  for all to service_role using (true) with check (true);
