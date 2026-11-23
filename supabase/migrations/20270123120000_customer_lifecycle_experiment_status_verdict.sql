-- customer_lifecycle_experiments — status-provenance + persisted-verdict columns
-- (spec: renewal-reminder-launch-readiness Phases 4–5 ·
-- [[../../docs/brain/tables/customer_lifecycle_experiments]]).
--
-- Phase 4 makes `status` the real on/off switch written ONLY through the SDK
-- chokepoint `setExperimentStatus` (src/lib/subscriber-experiments.ts), which records
-- WHO flipped it and WHY (north star: no silent proxy flip). Phase 5's guardrail/verdict
-- cron persists the terminal verdict on the primary metric instead of deriving it live.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (CLAUDE.md idempotent-SQL-migration rail).

ALTER TABLE public.customer_lifecycle_experiments
  ADD COLUMN IF NOT EXISTS status_changed_by text,
  ADD COLUMN IF NOT EXISTS status_changed_reason text,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  -- Persisted terminal verdict on the primary metric (treatment_wins | holdout_wins |
  -- no_difference | inconclusive) + the numbers behind it. Null until the test concludes.
  ADD COLUMN IF NOT EXISTS verdict text,
  ADD COLUMN IF NOT EXISTS verdict_detail jsonb,
  ADD COLUMN IF NOT EXISTS verdict_at timestamptz;
