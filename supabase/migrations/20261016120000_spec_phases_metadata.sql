-- marco-logistics-director-seat Phase 1 — add public.spec_phases.metadata (per-phase decision surface).
-- See docs/brain/specs/marco-logistics-director-seat.md § Phase 1.
--
-- BACKGROUND. The marco-logistics landing spec has a Phase 1 whose only job is to RECORD the A-vs-B
-- landing DECISION durably — the remaining phases gate on it ("[Executes only when Phase 1 decided
-- A/B.]"). The decision is not shipping/build provenance (build_sha/pr/merge_sha reserve those slots)
-- and is not the phase body/verification prose (those are the authored content the runner reads).
--
-- A per-phase jsonb `metadata` bag is the correct semantic slot: a small, additive, forward-compatible
-- column that a specs-table SDK writer (setPhaseMetadata) stamps and future readers (Phase 3's chained
-- build, the phase-notes viewer) key on. Same shape as director_activity.metadata / the many jsonb
-- side-channel bags across the schema — the phase's structured, non-provenance side-channel.
--
-- Nullable-with-default: existing rows already have '{}'::jsonb (default fills them), so no backfill.
-- The two RPCs read spec_phases via `to_jsonb(p)` (20261001120000_list_specs_with_phases_rpc.sql +
-- 20261004120000_get_spec_with_phases_rpc.sql), so this new column flows through the join without any
-- RPC migration churn. No trigger interaction — the rollup triggers are already dropped
-- (20260725160000_drop_rollup_triggers_and_milestone_status.sql), so this write is inert to status
-- derivation.
--
-- ADDITIVE + IDEMPOTENT (ADD COLUMN IF NOT EXISTS). No index — the metadata bag is read alongside the
-- row (via `to_jsonb(p)`), never scanned across phases.

alter table public.spec_phases
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.spec_phases.metadata is
  'marco-logistics-director-seat Phase 1 — per-phase jsonb side-channel bag for structured, non-provenance '
  'phase state. Written via specs-table.setPhaseMetadata; read via getSpec/listSpecs (flowed through the '
  'get_spec_with_phases / list_specs_with_phases RPCs by to_jsonb(p)). Distinct from build_sha / pr / '
  'merge_sha (phase provenance) and body / verification / why / what (authored content).';
