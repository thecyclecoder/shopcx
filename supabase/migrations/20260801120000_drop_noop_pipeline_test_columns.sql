-- Drop the throwaway no-op columns the noop-pipeline-test-1..6 PM-flow validation specs added to
-- public.director_activity. They had no reader or writer — purely additive markers to exercise the
-- migration script-approval gate of the one-off PM pipeline. The validation served its purpose; this
-- supersedes the ADD-migrations (which stay in the ledger as applied history). Idempotent.
alter table public.director_activity drop column if exists _noop_pipeline_test;   -- reversible: throwaway PM-flow test column, no reader/writer
alter table public.director_activity drop column if exists _noop_pipeline_test_2; -- reversible: throwaway PM-flow test column, no reader/writer
alter table public.director_activity drop column if exists _noop_pipeline_test_3; -- reversible: throwaway PM-flow test column, no reader/writer
alter table public.director_activity drop column if exists _noop_pipeline_test_4; -- reversible: throwaway PM-flow test column, no reader/writer
alter table public.director_activity drop column if exists _noop_pipeline_test_6; -- reversible: throwaway PM-flow test column, no reader/writer
