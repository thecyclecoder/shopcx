-- [TEST] No-op pipeline validation v2 — Phase 2. See docs/brain/specs/noop-pipeline-test-2.md.
-- Additive, nullable, no default, written by nothing, read by nothing. `if not exists` makes it
-- idempotent. Exists so the pipeline exercises the migration script-approval gate end-to-end.
alter table public.director_activity add column if not exists _noop_pipeline_test_2 text;
