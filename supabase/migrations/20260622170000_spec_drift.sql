-- Spec-Drift Agent — surfaced phase-emoji drift (see docs/brain/specs/spec-drift-agent.md).
--
-- The reconciler (src/lib/spec-drift.ts) keeps a spec's ⏳/🚧/✅ phase emojis in sync with shipped
-- code. It AUTO-FLIPS a phase ✅ when its claimed code is on `main` AND a build PR has merged for the
-- spec. The residual it CAN'T confidently auto-flip — a phase whose code is on main but with no merged
-- build on record — lands here as an open row, surfaced on the Control Tower for a one-tap owner flip
-- (rather than a wrong auto-flip). One OPEN row per (workspace, spec, phase); resolved when the phase
-- flips ✅ (owner tap or a later reconcile) or stops drifting.
--
-- Workspace-scoped (the merged-build evidence + the one-tap flip are per workspace). RLS: any
-- authenticated user reads; service role does all writes (the reconciler holds the creds).

create table if not exists public.spec_drift (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the drifting spec (docs/brain/specs/{slug}.md).
  spec_slug text not null,
  -- 0-based phase index, matching the board parser order + /api/roadmap/status phaseIndex.
  phase_index int not null,
  phase_title text not null,
  -- the phase's stale emoji at detection time (⏳ or 🚧).
  current_emoji text not null,
  -- human-readable drift summary ("{slug} — P{n} (title) code is on main but still ⏳ …").
  detail text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- One OPEN row per (workspace, spec, phase) — the de-dupe spine (the reconciler upserts against this:
-- insert on first sight, bump last_seen_at on repeat).
create unique index if not exists spec_drift_one_open_per_phase
  on public.spec_drift (workspace_id, spec_slug, phase_index) where status = 'open';
create index if not exists spec_drift_ws_status_idx
  on public.spec_drift (workspace_id, status, last_seen_at desc);

alter table public.spec_drift enable row level security;
drop policy if exists spec_drift_select on public.spec_drift;
create policy spec_drift_select on public.spec_drift
  for select to authenticated using (auth.uid() is not null);
drop policy if exists spec_drift_service on public.spec_drift;
create policy spec_drift_service on public.spec_drift
  for all to service_role using (true) with check (true);
