-- Storefront campaign-grading loop — the Head-of-Growth supervisory feedback signal
-- (docs/brain/specs/storefront-campaign-grading-loop.md, M5 of the storefront-optimizer goal).
--
-- The grading loop closes the CEO → Growth → Optimizer chain: the Growth director grades
-- each concluded M4 campaign 1–10, scoring HYPOTHESIS QUALITY separately from RESULT (a sound
-- hypothesis that lost is good learning → high; a lucky win from a sloppy hypothesis → low).
-- Two grades per campaign, both kept: an INITIAL grade at significance (on the proxy + the
-- agent's reasoning) and a REVISED grade ~4 months later when the M3 reconciler lands the
-- cohort's actual LTV. Grades feed back to the M4 agent (and M2) as a training signal.
--
-- Two tables (mirroring the shipped ticket-grader pattern — ticket_analyses + grader_prompts):
--   storefront_campaign_grades — one row per campaign (the M4 storefront_experiments record):
--                                grade_initial + grade_revised (both persist), the
--                                hypothesis_quality / result_quality sub-scores scored
--                                SEPARATELY, reasoning, graded_by ∈ agent|human, and the
--                                human override provenance (overridden_by member).
--   storefront_grader_prompts  — the calibration store (status ∈ proposed|approved|rejected|
--                                archived, derived_from_*) so the Growth director corrects the
--                                grader's scoring on edge cases — same arc as grader_prompts.
--
-- Safety invariants baked in here:
--   • grade_initial / grade_revised / sub-scores CHECK in [1,10]
--   • graded_by CHECK ∈ agent|human
--   • status CHECK ∈ proposed|approved|rejected|archived on the calibration store
--   • one grade row per campaign (experiment_id UNIQUE) — idempotent grading, never duplicated
--   • both grades persist (grade_revised is a separate nullable column — the initial proxy-time
--     grade is NEVER overwritten by the revised actual-LTV grade; the gap stays auditable)
-- RLS mirrors storefront_experiments: workspace-member SELECT, service-role write.

-- ── storefront_campaign_grades — one row per campaign (M4 experiment) ──────────
create table if not exists public.storefront_campaign_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- One grade row per campaign (the M4 storefront_experiments record). UNIQUE ⇒ idempotent
  -- grading: a re-run UPDATEs in place per mode, never inserts a duplicate.
  experiment_id uuid not null unique references public.storefront_experiments(id) on delete cascade,

  -- ── The INITIAL grade (at significance, on the proxy + the agent's reasoning) ──
  grade_initial integer check (grade_initial between 1 and 10),
  grade_initial_reasoning text,
  -- Scored SEPARATELY from result: a sound hypothesis that lost scores high here.
  hypothesis_quality integer check (hypothesis_quality between 1 and 10),
  -- The realized proxy outcome quality — independent of hypothesis quality.
  result_quality integer check (result_quality between 1 and 10),
  initial_graded_at timestamptz,

  -- ── The REVISED grade (~4 months later, when M3's actual LTV lands) ───────────
  -- Nullable until the cohort reconciles. NEVER overwrites grade_initial — both persist so the
  -- proxy-vs-reality gap is auditable.
  grade_revised integer check (grade_revised between 1 and 10),
  grade_revised_reasoning text,
  revised_graded_at timestamptz,

  -- ── Supervision (the human-overridable gate) ─────────────────────────────────
  -- 'agent' = the grader scored it; 'human' = the Growth director overrode.
  graded_by text not null default 'agent' check (graded_by in ('agent', 'human')),
  -- The workspace member who overrode (nullable until an override happens).
  overridden_by uuid references auth.users(id) on delete set null,
  override_reason text,
  overridden_at timestamptz,

  -- ── Model / cost accounting (mirror ticket_analyses) ─────────────────────────
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cost_cents numeric(10, 4) default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_campaign_grades_ws_idx
  on public.storefront_campaign_grades (workspace_id, created_at desc);
-- Revised-grading lookup: campaigns with an initial grade still awaiting their revised grade.
create index if not exists storefront_campaign_grades_pending_revised_idx
  on public.storefront_campaign_grades (workspace_id)
  where grade_initial is not null and grade_revised is null;

-- ── storefront_grader_prompts — the calibration store (mirror grader_prompts) ──
create table if not exists public.storefront_grader_prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  title text not null,
  content text not null,

  -- 'proposed' (waiting for Growth review) | 'approved' (injected into the grader prompt)
  -- | 'rejected' | 'archived'. Only 'approved' rules calibrate the grader.
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'archived')),

  -- Provenance — born from an override on a grade, or from a large initial-vs-revised gap.
  derived_from_experiment_id uuid references public.storefront_experiments(id) on delete set null,
  derived_from_grade_id uuid references public.storefront_campaign_grades(id) on delete set null,
  proposed_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,

  sort_order integer default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_grader_prompts_ws_status_idx
  on public.storefront_grader_prompts (workspace_id, status);

-- ── RLS — workspace-member SELECT, service-role write (mirror storefront_experiments) ──
alter table public.storefront_campaign_grades enable row level security;
drop policy if exists storefront_campaign_grades_select on public.storefront_campaign_grades;
create policy storefront_campaign_grades_select on public.storefront_campaign_grades
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_campaign_grades_service on public.storefront_campaign_grades;
create policy storefront_campaign_grades_service on public.storefront_campaign_grades
  for all to service_role using (true) with check (true);

alter table public.storefront_grader_prompts enable row level security;
drop policy if exists storefront_grader_prompts_select on public.storefront_grader_prompts;
create policy storefront_grader_prompts_select on public.storefront_grader_prompts
  for select to authenticated using (auth.uid() is not null);
drop policy if exists storefront_grader_prompts_service on public.storefront_grader_prompts;
create policy storefront_grader_prompts_service on public.storefront_grader_prompts
  for all to service_role using (true) with check (true);
