-- pm-structured-intent-and-refs Phase 3 — structured verification as per-check rows.
-- See docs/brain/specs/pm-structured-intent-and-refs.md § Phase 3.
--
-- Replaces the free-text `spec_phases.verification` blob with `public.spec_phase_checks` — ONE ROW PER
-- CHECK. Each row carries:
--   - `phase_id` — FK to public.spec_phases (on delete cascade)
--   - `position` — 1-indexed ordering within the phase
--   - `description` — the plain-language "- On {where}, {do what} → expect {observable result}" line
--   - `kind` — `auto` (an auto-testable non-destructive check the spec-test agent runs directly) or
--     `human` (a check that requires a human verifier — the box QA agent parks it needs_human).
--
-- The spec-test agent (docs/brain/specs/spec-test-agent.md) reads these ROWS instead of parsing the
-- verification text blob; it writes a per-row verdict (`spec_phase_check_verdicts` row / a per-row
-- entry on `spec_test_runs.results` — the shape those Phase-3 lanes decide). The existing
-- spec_phases.verification text column stays for legacy readers + backward compat; new authoring
-- writes both surfaces during the migration window.
--
-- Idempotent. Nullable-friendly for backfill (existing phases can hydrate rows from their
-- verification text; the app-layer gate enforces ≥1 check per phase for NEW authoring going forward).

create table if not exists public.spec_phase_checks (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid not null references public.spec_phases(id) on delete cascade,
  position int not null,
  description text not null,
  kind text not null default 'auto' check (kind in ('auto', 'human')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (phase_id, position). The author chokepoint REPLACES the check set by
-- position when a phase is re-authored, mirroring the spec_phases upsert-by-position rule.
create unique index if not exists spec_phase_checks_phase_position
  on public.spec_phase_checks (phase_id, position);
create index if not exists spec_phase_checks_phase_idx on public.spec_phase_checks (phase_id);

alter table public.spec_phase_checks enable row level security;

drop policy if exists spec_phase_checks_select on public.spec_phase_checks;
create policy spec_phase_checks_select on public.spec_phase_checks
  for select to authenticated using (auth.uid() is not null);
drop policy if exists spec_phase_checks_service on public.spec_phase_checks;
create policy spec_phase_checks_service on public.spec_phase_checks
  for all to service_role using (true) with check (true);

comment on table public.spec_phase_checks is
  'pm-structured-intent-and-refs Phase 3 — one row per verification check on a spec phase. Replaces '
  'the free-text spec_phases.verification blob; the box spec-test agent reads THESE rows and writes a '
  'per-row verdict. The chokepoint (author-spec.assertEveryPhaseHasChecks) gates >=1 check per phase '
  'the same rail as the verification-text gate. `kind` splits `auto` (spec-test runs directly) from '
  '`human` (parked needs_human).';
