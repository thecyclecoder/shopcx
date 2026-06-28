-- specs-status-override-only — specs.status is OVERRIDE-ONLY; a DERIVED state must be NULL.
--
-- THE RULE (CLAUDE.md / operational-rules): "Derived status comes from the phase rollup; stored status
-- columns are explicit lifecycle overrides only." The deriving readers (brain-roadmap.ts
-- `deriveSpecCardStatus`) treat the stored `specs.status` column as an explicit lifecycle OVERRIDE only:
--   - in_review  — newly authored / sent back; the build pipeline holds it.
--   - deferred   — CEO parked it (also mirrored on `specs.deferred`).
--   - folded     — archived after a fold.
-- The planned/in_progress/in_testing/shipped axis is PURELY DERIVED from the phase rollup (no DB trigger
-- maintains this column — the rollup trigger was dropped in
-- 20260725160000_drop_rollup_triggers_and_milestone_status.sql). Persisting a derived state here is a BUG:
-- the readers ignore it, but it lies in the DB and a future reader could leak it.
--
-- This migration makes "purely derived" expressible as NULL:
--   1. Drop the NOT NULL constraint on specs.status.
--   2. Replace the CHECK so NULL is allowed (NULL = no override → status is purely the phase rollup).
--      The non-null values stay the SAME enum (in_review / planned / in_progress / shipped / deferred /
--      folded). `planned`/`in_progress`/`shipped` remain ACCEPTED for backward compat with any historical
--      row, but the app writers (dualWriteSpecRow / applyAdaDisposition / setSpecStatus) now CLEAR to NULL
--      for any derived destination — only true overrides are ever persisted.
--   3. Keep the default `in_review` (every newly-authored spec lands in_review — a real override — so a
--      freshly inserted row without an explicit status still starts in the correct hold state).
--
-- The companion app change clears `specs.status` to NULL for a derived destination (planned/in_progress/
-- shipped) and the one-off cleanup nulls the 2 already-bugged rows (noop-pipeline-test-4 / -5).

alter table public.specs alter column status drop not null;

alter table public.specs drop constraint if exists specs_status_check;
alter table public.specs add constraint specs_status_check check (
  status is null or status in ('in_review','planned','in_progress','shipped','deferred','folded')
);
