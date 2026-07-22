-- Worker-action grade store + calibration rubric — the DevOps Director's supervisory feedback signal,
-- one level DOWN the org chart from director_decision_grades (worker-grading-and-director-management.md,
-- Phase 1; hardens the devops-director goal "the org learns + self-manages").
--
-- The cascade (north star): CEO grades+coaches the Director (director_decision_grades) → the Director
-- grades+coaches each Worker (THIS store). Each layer judges the layer below against an explicit rubric
-- and coaches when the grade slips. This migration mirrors director_decision_grades one level down.
--
-- Gradeable unit: one CONCLUDED agent_jobs row — a build merged, an error fixed/dismissed, an index
-- proposed, a spec verified. The job IS the worker's atomic action, so the polymorphic-key shape the
-- director store needs collapses to a single FK (agent_job_id) here.
--
-- Two tables (mirror the director / storefront grader pattern):
--   worker_action_grades — one row per graded concluded agent_jobs row. grade (1–10) + reasoning,
--       worker_kind denormalized (agent_jobs.kind) for the last-10 rollup, graded_by ∈ agent|human
--       (CEO-overridable), and the human override provenance.
--   worker_grader_prompts — the human-approved calibration store (status ∈ proposed|approved|rejected|
--       archived, derived_from_*) so the CEO corrects the grader's per-worker rubric on edge cases —
--       same arc as director_grader_prompts. worker_kind nullable (null = applies to every worker).
--
-- Safety invariants (worker-grading-and-director-management.md § the locked config):
--   • grade CHECK in [1,10]; graded_by CHECK ∈ agent|human; status CHECK ∈ proposed|approved|rejected|
--     archived on the calibration store.
--   • Idempotent grading — one row per concluded job: a UNIQUE on agent_job_id. A re-run UPDATEs in
--     place, never inserts a duplicate.
--   • Human-overridable — graded_by flips to 'human' + overridden_by records who; the agent never
--     re-writes a human grade.
-- RLS mirrors worker_coaching_log / director_decision_grades: any authenticated user SELECTs (the
-- worker-profile report is owner-gated above the DB), service-role does all writes.

-- ── worker_action_grades — one row per graded concluded worker action ──────────
create table if not exists public.worker_action_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The gradeable unit: the concluded agent_jobs row this grade scores.
  agent_job_id uuid not null references public.agent_jobs(id) on delete cascade,
  -- The worker the action belongs to (agent_jobs.kind) — denormalized so the last-10 rollup is a single
  -- index scan, never a join back through agent_jobs.
  worker_kind text not null,
  -- The spec/slug the action was for, if any (context for the report; no FK — specs are markdown).
  spec_slug text,

  -- The 1–10 grade + the grader's stated "why" (the auditable reasoning, per the worker's rubric).
  grade integer check (grade between 1 and 10),
  reasoning text,

  -- ── Supervision (the human-overridable gate, mirror director_decision_grades) ─
  -- 'agent' = the grader scored it; 'human' = the CEO/director overrode.
  graded_by text not null default 'agent' check (graded_by in ('agent', 'human')),
  overridden_by uuid references auth.users(id) on delete set null,
  override_reason text,
  overridden_at timestamptz,

  -- ── Model / cost accounting (mirror director_decision_grades) ────────────────
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cost_cents numeric(10, 4) default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent grading — one row per concluded agent_jobs row.
create unique index if not exists worker_action_grades_job_uniq
  on public.worker_action_grades (agent_job_id);
-- Workspace report ordering.
create index if not exists worker_action_grades_ws_idx
  on public.worker_action_grades (workspace_id, created_at desc);
-- The last-10 rollup + trend per worker (worker-grader.ts computeWorkerRollup).
create index if not exists worker_action_grades_worker_idx
  on public.worker_action_grades (workspace_id, worker_kind, created_at desc);

-- ── worker_grader_prompts — the calibration store (mirror director_grader_prompts) ─
create table if not exists public.worker_grader_prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The worker this rubric correction applies to (agent_jobs.kind). NULL = applies to every worker
  -- (a cross-cutting calibration rule).
  worker_kind text,

  title text not null,
  content text not null,

  -- 'proposed' (waiting for CEO review) | 'approved' (injected into the grader prompt)
  -- | 'rejected' | 'archived'. Only 'approved' rules calibrate the grader.
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'archived')),

  -- Provenance — born from an override on a grade (a large grade gap → a proposed rule).
  derived_from_job_id uuid references public.agent_jobs(id) on delete set null,
  derived_from_grade_id uuid references public.worker_action_grades(id) on delete set null,
  proposed_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,

  sort_order integer default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists worker_grader_prompts_ws_status_idx
  on public.worker_grader_prompts (workspace_id, status);
-- Per-worker rubric lookup (worker_kind-specific + cross-cutting NULL rows).
create index if not exists worker_grader_prompts_worker_idx
  on public.worker_grader_prompts (workspace_id, worker_kind, status);

-- ── RLS — authenticated SELECT, service-role write (mirror worker_coaching_log) ──
alter table public.worker_action_grades enable row level security;
drop policy if exists worker_action_grades_select on public.worker_action_grades;
create policy worker_action_grades_select on public.worker_action_grades
  for select to authenticated using (auth.uid() is not null);
drop policy if exists worker_action_grades_service on public.worker_action_grades;
create policy worker_action_grades_service on public.worker_action_grades
  for all to service_role using (true) with check (true);

alter table public.worker_grader_prompts enable row level security;
drop policy if exists worker_grader_prompts_select on public.worker_grader_prompts;
create policy worker_grader_prompts_select on public.worker_grader_prompts
  for select to authenticated using (auth.uid() is not null);
drop policy if exists worker_grader_prompts_service on public.worker_grader_prompts;
create policy worker_grader_prompts_service on public.worker_grader_prompts
  for all to service_role using (true) with check (true);
