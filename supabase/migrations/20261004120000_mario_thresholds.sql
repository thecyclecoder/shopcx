-- mario_thresholds — Mario's self-owned SLA table. One row per (workspace_id,
-- from_event, to_event) pair carrying the SLA (in ms) beyond which Mario treats
-- the gap as a stall. Seeded at migration time with the M3 defaults; the M4
-- self-tuning agent is the sole writer of updates (last_widened_at + reason
-- record every widening so a human can audit why the SLA moved).
--
-- Reads: src/lib/mario.ts `evaluateStalledSpecs` — the M3 detector cron converts
-- each row into an older_than_ms input to `listStalledCandidates`
-- ([[../libraries/spec-timecards]]).
-- Writes: the M3 migration seeds defaults; the M4 self-tuning updates them.
-- No dashboard writer — the table is Mario-owned.

create table if not exists public.mario_thresholds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- both are free text (no CHECK) — mirrors the spec_timecard_events.event_kind
  -- convention so a new lifecycle event lands without a migration; the SDK
  -- (src/lib/mario.ts) owns the vocabulary.
  from_event text not null,
  to_event text not null,
  -- SLA between from_event and to_event; a gap greater than this is a stall
  sla_ms bigint not null,
  -- how many independent stalled specs must show the same overshoot before M4
  -- widens the SLA — a bounded proxy against a single flaky spec moving the row
  min_count int not null default 1,
  -- audit trail for the M4 self-tuner: when + why the SLA was last widened
  last_widened_at timestamptz,
  last_widened_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, from_event, to_event)
);

-- Seed the M3 defaults for every existing workspace. Idempotent via the unique
-- constraint — re-running the migration is a no-op on rows that already exist,
-- so a per-workspace tuning made after the first apply is never clobbered.
insert into public.mario_thresholds (workspace_id, from_event, to_event, sla_ms, min_count)
select w.id, v.from_event, v.to_event, v.sla_ms, v.min_count
from public.workspaces w
cross join (values
  -- phase built → shipped: builder-worker's stampPhaseBuilt to the PR merge
  ('build_done'::text,        'phase_shipped'::text,     1800000::bigint, 1::int),
  -- Vale's review sweep: review_started to a pass/fail verdict
  ('review_started',          'review_passed',           1200000,         1),
  -- spec-test agent: run started to verdict
  ('spec_test_started',       'spec_test_verdict',       1800000,         1),
  -- fold: fold_started to folded (the final lifecycle event)
  ('fold_started',            'folded',                  1200000,         1),
  -- worker-liveness SLA: a queued job that nothing has claimed in 10min is a stall
  ('job_queued',              'job_claimed',              600000,         1),
  -- next-phase gap: a shipped phase should have the next phase's build_started
  -- picked up within one SLA window (the auto-queue chain).
  ('phase_shipped',           'build_started',           1800000,         1)
) as v(from_event, to_event, sla_ms, min_count)
on conflict (workspace_id, from_event, to_event) do nothing;

alter table public.mario_thresholds enable row level security;

-- RLS mirrors spec_timecard_events: workspace members read; service role writes.
drop policy if exists mario_thresholds_select on public.mario_thresholds;
create policy mario_thresholds_select on public.mario_thresholds
  for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = mario_thresholds.workspace_id
        and wm.user_id = auth.uid()
    )
  );

drop policy if exists mario_thresholds_service on public.mario_thresholds;
create policy mario_thresholds_service on public.mario_thresholds
  for all to service_role
  using (true) with check (true);
