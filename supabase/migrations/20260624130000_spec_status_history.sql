-- spec-status-db-driven Phase 1: spec_status_history audit table.
--
-- See docs/brain/specs/spec-status-db-driven.md. Status / per-phase status / **Priority:** critical /
-- **Deferred:** parked all move out of the spec markdown and into `spec_card_state` (existing table)
-- so a status flip is one DB write — no markdown commit, no Vercel deploy. The board reads
-- `spec_card_state` DB-authoritatively. The two new boolean flags live on the existing
-- `spec_card_state.flags` jsonb column (no schema change required there), and the rollup status
-- column keeps its existing CHECK values — a deferred spec sits at its phase-rollup `status` with
-- `flags.deferred=true`, and the overlay returns 'deferred' for display. So the ONLY schema change
-- this migration makes is creating the audit table — the rest of Phase 1 is application code only.
--
-- The audit table replaces what `git log docs/brain/specs/{slug}.md` gave us for free before the
-- writers stopped committing: who flipped what, when, and why (commit-message equivalent in `reason`).
-- Append-only — never updated, never deleted.

create table if not exists public.spec_status_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  spec_slug text not null,
  -- which thing transitioned: 'status' (overall), 'phase' (one phase), 'critical' (flag), 'deferred' (flag).
  field text not null check (field in ('status', 'phase', 'critical', 'deferred')),
  -- 0-based phase index when field='phase'; null otherwise.
  phase_index int,
  -- JSON-stringified prior + new values; '"planned"' / 'true' / '"shipped"' / etc. Nullable from_value
  -- so the first-ever write for a spec records null → to_value cleanly.
  from_value text,
  to_value text not null,
  -- who: 'owner:<user_id>' | 'merge:<sha>' | 'drift:reconciler' | 'box:<job_id>' | 'backfill' | 'ada' | ...
  actor text not null,
  -- free-text reason (the commit-message equivalent).
  reason text,
  at timestamptz not null default now()
);

create index if not exists spec_status_history_slug_at
  on public.spec_status_history (workspace_id, spec_slug, at desc);
create index if not exists spec_status_history_field_at
  on public.spec_status_history (workspace_id, field, at desc);

alter table public.spec_status_history enable row level security;

drop policy if exists spec_status_history_select on public.spec_status_history;
create policy spec_status_history_select on public.spec_status_history
  for select to authenticated using (auth.uid() is not null);

drop policy if exists spec_status_history_service on public.spec_status_history;
create policy spec_status_history_service on public.spec_status_history
  for all to service_role using (true) with check (true);
