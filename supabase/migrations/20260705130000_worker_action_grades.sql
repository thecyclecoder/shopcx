-- Worker-action grade store + calibration rubric — the DIRECTOR's supervisory feedback signal
-- (docs/brain/specs/worker-grading-and-director-management.md, P1). One level DOWN the org chart from
-- director_decision_grades + director_grader_prompts: there the CEO grades the Platform/DevOps
-- Director's CALLS; here the Director (Ada) grades each WORKER's concluded actions — was the build
-- merged clean, the error correctly fixed/dismissed, the index sound, the spec verification right —
-- 1–10 + reasoning, and a slipping rollup triggers a coachWorker pass (the CEO→Director→Worker cascade).
--
-- The gradeable unit is ONE concluded agent_jobs row (a build merged, an error fixed/dismissed, an
-- index proposed, a spec verified) — the worker's atomic action. Grading is idempotent per job and
-- human-overridable, exactly mirroring director_decision_grades one level up.
--
-- Two tables (mirroring director_decision_grades / director_grader_prompts):
--   worker_action_grades  — one row per graded worker action, keyed to the concluded agent_jobs row.
--       grade (1–10) + reasoning, graded_by ∈ agent|human, the human-override provenance, model/cost.
--   worker_grader_prompts — the human-approved (CEO-calibratable) rubric store (status ∈ proposed|
--       approved|rejected|archived, derived_from_*) so the CEO corrects the grader's scoring on edge
--       cases — same arc as director_grader_prompts. A rule is per-worker (worker_kind set) or global
--       (worker_kind null = applies to every worker); only 'approved' rules reach the grader prompt.
--
-- Safety invariants baked in here (mirror director_decision_grades):
--   • grade CHECK in [1,10]; graded_by CHECK ∈ agent|human; status CHECK ∈ proposed|approved|rejected|
--     archived on the calibration store.
--   • Idempotent grading — one row per concluded job: a UNIQUE on agent_job_id. A re-run UPDATEs in
--     place, never inserts a duplicate.
--   • Human-overridable — graded_by flips to 'human' + overridden_by records who; the agent never
--     re-writes a human grade.
-- RLS mirrors director_decision_grades / approval_decisions: any authenticated user SELECTs (the
-- Agents-hub / worker-profile report is owner-gated above the DB), service-role does all writes.

-- ── worker_action_grades — one row per graded worker action (concluded agent_jobs row) ────────────
create table if not exists public.worker_action_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- the worker graded — the agent_jobs kind (e.g. 'build', 'repair', 'db_health', 'spec-test').
  worker_kind text not null,
  -- the concluded agent_jobs row this grade scores (the worker's atomic action). Always set: a worker
  -- grade is ALWAYS about one concluded job (no polymorphic key — that's the one-level-down simplification
  -- vs director_decision_grades, where a call is an auto-approval OR a goal-escort).
  agent_job_id uuid not null references public.agent_jobs(id) on delete cascade,

  -- The 1–10 grade + the grader's stated "why" (the auditable reasoning).
  grade integer check (grade between 1 and 10),
  reasoning text,

  -- ── Supervision (the human-overridable gate) ─────────────────────────────────
  -- 'agent' = the grader scored it; 'human' = the CEO/owner overrode.
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

-- Idempotent grading — one row per concluded job (a re-run UPDATEs in place).
create unique index if not exists worker_action_grades_job_uniq
  on public.worker_action_grades (agent_job_id);

create index if not exists worker_action_grades_ws_idx
  on public.worker_action_grades (workspace_id, created_at desc);
-- Per-worker rollup (last-10 window) + trend lookup.
create index if not exists worker_action_grades_worker_idx
  on public.worker_action_grades (workspace_id, worker_kind, created_at desc);

-- ── worker_grader_prompts — the calibration store (mirror director_grader_prompts) ──────────────
create table if not exists public.worker_grader_prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- which worker this rule calibrates; NULL = a global rule applied to every worker.
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

-- ── RLS — authenticated SELECT, service-role write (mirror director_decision_grades) ─────────────
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
