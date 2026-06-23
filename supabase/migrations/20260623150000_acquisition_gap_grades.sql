-- Acquisition gap-grading loop — the Growth-director feedback signal for the scouts
-- (docs/brain/specs/acquisition-research-loop-grading.md, Phase 1; M5 of the Acquisition Research
-- Engine, docs/brain/goals/acquisition-research-engine.md).
--
-- Makes the Acquisition Research Engine CONSTANT research, not one-shot: the standing cadence
-- (acquisition-research-cadence cron) keeps the scouts running, and this grade closes the loop by
-- scoring each surfaced gap → its outcome 1–10. It mirrors the shipped storefront campaign-grading
-- loop (storefront_campaign_grades + storefront_grader_prompts) exactly:
--   • GAP_QUALITY is scored SEPARATELY from OUTCOME — was the gap REAL and worth surfacing
--     (independent-brand evidence, the owner approved it)? A sound gap whose experiment lost still
--     scores high on gap_quality; a flimsy gap the owner rejected scores low regardless.
--   • Two grades per gap, both kept: an INITIAL grade when the gap is acted-on (approved | rejected)
--     and a REVISED grade once the routed action's outcome resolves (the build shipped / the
--     experiment won or lost). The initial grade is NEVER overwritten — the gap stays auditable.
-- Grades TRAIN the scouts: loadGapTypeGradeSignal feeds a per-gap_type bias so a low-value/rejected
-- gap type gets DOWN-WEIGHTED over time (suppressed from re-surfacing) rather than endlessly re-proposed.
--
-- Two tables (mirroring the ticket-grader + storefront-grader pattern):
--   acquisition_gap_grades   — one row per surfaced gap (keyed on gap_source + gap_id; the gap lives in
--                              either ad_gap_recommendations or lander_recommendations, so gap_id has no
--                              FK). grade_initial + grade_revised (both persist), gap_quality /
--                              outcome_quality sub-scores scored SEPARATELY, the derived outcome_state,
--                              graded_by ∈ agent|human, and the human override provenance.
--   acquisition_grader_prompts — the calibration store (status ∈ proposed|approved|rejected|archived,
--                              derived_from_*) so the Growth director corrects the grader on edge cases.
--
-- RLS mirrors competitors / ad_gap_recommendations: workspace-member SELECT, service-role write.

-- ── acquisition_gap_grades — one row per surfaced gap ──────────────────────────
create table if not exists public.acquisition_gap_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Which gap queue the graded gap lives in, and its row id there. No FK: the gap is in one of two
  -- tables. UNIQUE (workspace_id, gap_source, gap_id) ⇒ idempotent grading, never duplicated.
  gap_source text not null check (gap_source in ('ad', 'lander')),
  gap_id uuid not null,
  -- Informational copies (so the training signal + report read without a join back to the gap row).
  product_id uuid references public.products(id) on delete set null,
  gap_type text not null,

  -- ── The INITIAL grade (when the gap is acted-on: approved | rejected) ──
  grade_initial integer check (grade_initial between 1 and 10),
  grade_initial_reasoning text,
  -- Scored SEPARATELY from outcome: was the gap REAL and worth surfacing? A sound gap that lost
  -- still scores high here; a flimsy gap the owner rejected scores low.
  gap_quality integer check (gap_quality between 1 and 10),
  -- How the resulting action performed (approved→shipped→won, or rejected) — independent of gap_quality.
  outcome_quality integer check (outcome_quality between 1 and 10),
  initial_graded_at timestamptz,

  -- ── The REVISED grade (once the routed action's outcome resolves) ──
  -- Nullable until the build ships / the experiment wins-or-loses. NEVER overwrites grade_initial.
  grade_revised integer check (grade_revised between 1 and 10),
  grade_revised_reasoning text,
  revised_graded_at timestamptz,

  -- The derived lifecycle state the grade was taken against:
  --   rejected — the owner rejected the gap (low gap_quality signal).
  --   approved — approved, routed, not yet shipped/resolved.
  --   shipped  — the routed Build PR landed / the experiment launched.
  --   won      — the routed experiment was promoted (a validated win).
  --   lost     — the routed experiment was killed / rolled back.
  outcome_state text not null default 'approved'
    check (outcome_state in ('rejected', 'approved', 'shipped', 'won', 'lost')),

  -- ── Supervision (the human-overridable gate) ──
  graded_by text not null default 'agent' check (graded_by in ('agent', 'human')),
  overridden_by uuid references auth.users(id) on delete set null,
  override_reason text,
  overridden_at timestamptz,

  -- ── Model / cost accounting (mirror storefront_campaign_grades) ──
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cost_cents numeric(10, 4) default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, gap_source, gap_id)
);

create index if not exists acquisition_gap_grades_ws_idx
  on public.acquisition_gap_grades (workspace_id, created_at desc);
-- The training-signal lookup: graded gaps per gap_type for a workspace.
create index if not exists acquisition_gap_grades_signal_idx
  on public.acquisition_gap_grades (workspace_id, gap_source, gap_type);
-- Revised-grading lookup: gaps with an initial grade still awaiting a revised grade.
create index if not exists acquisition_gap_grades_pending_revised_idx
  on public.acquisition_gap_grades (workspace_id)
  where grade_initial is not null and grade_revised is null;

-- ── acquisition_grader_prompts — the calibration store (mirror storefront_grader_prompts) ──
create table if not exists public.acquisition_grader_prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  title text not null,
  content text not null,

  -- Only 'approved' rules calibrate the grader (injected into its system prompt).
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'archived')),

  -- Provenance — born from an override on a grade, or a large initial-vs-revised gap.
  derived_from_gap_source text check (derived_from_gap_source in ('ad', 'lander')),
  derived_from_gap_id uuid,
  derived_from_grade_id uuid references public.acquisition_gap_grades(id) on delete set null,
  proposed_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,

  sort_order integer default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists acquisition_grader_prompts_ws_status_idx
  on public.acquisition_grader_prompts (workspace_id, status);

-- ── RLS — workspace-member SELECT, service-role write (mirror ad_gap_recommendations) ──
alter table public.acquisition_gap_grades enable row level security;
drop policy if exists acquisition_gap_grades_select on public.acquisition_gap_grades;
create policy acquisition_gap_grades_select on public.acquisition_gap_grades
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists acquisition_gap_grades_service on public.acquisition_gap_grades;
create policy acquisition_gap_grades_service on public.acquisition_gap_grades
  for all to service_role using (true) with check (true);

alter table public.acquisition_grader_prompts enable row level security;
drop policy if exists acquisition_grader_prompts_select on public.acquisition_grader_prompts;
create policy acquisition_grader_prompts_select on public.acquisition_grader_prompts
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
drop policy if exists acquisition_grader_prompts_service on public.acquisition_grader_prompts;
create policy acquisition_grader_prompts_service on public.acquisition_grader_prompts
  for all to service_role using (true) with check (true);
