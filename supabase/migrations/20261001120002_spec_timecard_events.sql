-- spec_timecard_events — per-lifecycle-step ledger for every spec so Mario can detect
-- the median stall (step-done to next-step-started beyond SLA) in under one SLA window.
--
-- Append-only. One row per lifecycle event: created, review pass/fail, phase build
-- start/done, ship, spec-test start/verdict, security verdict, fold start/done,
-- wait entered/exited, job queued/claimed. Free-text `event_kind` (no CHECK) —
-- mirrors the `agent_jobs.kind` convention so a new lifecycle event lands without
-- a migration; the SDK (src/lib/spec-timecards.ts) owns the vocabulary.
--
-- The only writer is src/lib/spec-timecards.ts `recordTimecardEvent` — all lifecycle
-- chokepoints call it best-effort (never blocks the caller on a write error).
-- Readers: `getTimecard` (per-spec timeline for the M5 detail-page timeline) and
-- `listStalledCandidates` (the M3 detector cron's per-step SLA scan).

create table if not exists public.spec_timecard_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  spec_slug text not null,
  -- nullable: a spec-level event (created / folded / …) has no phase
  phase_index int,
  -- free text, no CHECK — the SDK owns the vocabulary; mirrors agent_jobs.kind
  event_kind text not null,
  -- who/what emitted: 'worker' | 'vale' | 'sol' | 'mario' | 'owner' | 'ceo' | box worker job id
  actor text not null,
  -- one of needs_input | needs_approval | blocked_on_dependency | blocked_on_usage —
  -- set on wait_entered / wait_exited only
  wait_kind text,
  -- owner display name / 'ceo' / dependency slug — set with wait_kind
  waiting_on text,
  at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Covers both the per-spec timeline read (getTimecard) and the last-event-per-spec
-- scan (listStalledCandidates).
create index if not exists spec_timecard_events_lookup_idx
  on public.spec_timecard_events (workspace_id, spec_slug, at);

alter table public.spec_timecard_events enable row level security;

-- RLS mirrors agent_jobs: workspace members read; service role writes.
drop policy if exists spec_timecard_events_select on public.spec_timecard_events;
create policy spec_timecard_events_select on public.spec_timecard_events
  for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = spec_timecard_events.workspace_id
        and wm.user_id = auth.uid()
    )
  );

drop policy if exists spec_timecard_events_service on public.spec_timecard_events;
create policy spec_timecard_events_service on public.spec_timecard_events
  for all to service_role
  using (true) with check (true);
