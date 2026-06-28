-- NO-OP pipeline validation (noop-pipeline-test-1, Phase 2). Additive, nullable, unused scratch column.
-- Nothing reads or writes this column. Exists solely to force the migration-approval gate in the pipeline.
alter table public.director_activity add column if not exists _noop_pipeline_test text;
