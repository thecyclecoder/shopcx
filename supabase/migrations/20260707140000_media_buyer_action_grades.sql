-- media-buyer-test-winner-loop Phase 3 — Media Buyer action grades.
--
-- The grading pass extends the box grading cascade with a Media Buyer grade:
-- for each concluded promote/kill/replenish/fatigue-replenish [[director_activity]]
-- row emitted by the Media Buyer's cadence pass, resolve the source meta_ad_id's
-- realized ROAS from [[meta_attribution_daily]] AT LEAST 3 DAYS LATER (settled
-- attribution) and score decision_quality + outcome_quality separately.
--
-- The spec's discipline: a SOUND call that regressed on a later ROAS shift still
-- grades well on decision_quality — the grader scores the CALL against what the
-- Media Buyer could see at decision time, and scores the OUTCOME against what
-- realized attribution says at grading time. Two orthogonal axes.
--
-- One row per action (director_activity_id UNIQUE) — idempotent grading. Writes
-- go through the box worker (deterministic); RLS: workspace-member SELECT,
-- service-role write (mirrors [[storefront_campaign_grades]]).

create table if not exists public.media_buyer_action_grades (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The Media Buyer action row this grade scores. UNIQUE = idempotent grading —
  -- a re-run UPDATES in place, never inserts a duplicate. ON DELETE CASCADE so
  -- a deleted director_activity row also drops its grade (no orphan grades).
  director_activity_id uuid not null unique references public.director_activity(id) on delete cascade,

  -- Which media-buyer verb was graded — matches the [[director_activity]] action_kind vocab:
  --   media_buyer_promoted_winner · media_buyer_paused_loser
  --   media_buyer_replenished_test_cohort · media_buyer_fatigue_replenish_triggered
  action_kind text not null,

  -- The concrete creative the audit trail names (from the action row's metadata.source_meta_ad_id).
  source_meta_ad_id text,

  -- The ROAS the Media Buyer cited at decision time (from the action row's metadata.roas).
  -- Kept as-is so a re-grade doesn't lose the original signal.
  decision_roas numeric(10,4),

  -- The realized ROAS from [[meta_attribution_daily]] resolved AT GRADING TIME (>= 3 days after
  -- the action's created_at). NULL when the source meta_ad_id has no attribution in the window
  -- (a paused loser is often the null case — that IS the correct signal for the outcome score).
  realized_roas numeric(10,4),
  realized_window_start date,
  realized_window_end date,
  realized_spend_cents bigint,
  realized_revenue_cents bigint,

  -- ── The two orthogonal quality axes ──────────────────────────────────────────
  -- Was the CALL SOUND given what the Media Buyer could see at decision time?
  -- (A promote on a strong-ROAS winner scores high here even if the realized ROAS regressed.)
  decision_quality integer not null check (decision_quality between 1 and 10),
  -- Did the realized ROAS actually support the call? (Independent of decision quality.)
  outcome_quality integer not null check (outcome_quality between 1 and 10),
  -- The overall grade — a simple average of the two axes so the roll-up is legible.
  overall_grade integer not null check (overall_grade between 1 and 10),

  reasoning text,

  -- 'agent' = the deterministic grader; 'human' = the Growth Director overrode.
  graded_by text not null default 'agent' check (graded_by in ('agent', 'human')),
  overridden_by uuid references auth.users(id) on delete set null,
  override_reason text,
  overridden_at timestamptz,

  graded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists media_buyer_action_grades_ws_idx
  on public.media_buyer_action_grades (workspace_id, created_at desc);
create index if not exists media_buyer_action_grades_kind_idx
  on public.media_buyer_action_grades (workspace_id, action_kind, graded_at desc);

create or replace function public.media_buyer_action_grades_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists media_buyer_action_grades_touch_updated_at on public.media_buyer_action_grades;
create trigger media_buyer_action_grades_touch_updated_at
  before update on public.media_buyer_action_grades
  for each row execute function public.media_buyer_action_grades_touch_updated_at();

alter table public.media_buyer_action_grades enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_action_grades' and policyname = 'media_buyer_action_grades_select') then
    create policy media_buyer_action_grades_select on public.media_buyer_action_grades for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'media_buyer_action_grades' and policyname = 'media_buyer_action_grades_service') then
    create policy media_buyer_action_grades_service on public.media_buyer_action_grades for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
