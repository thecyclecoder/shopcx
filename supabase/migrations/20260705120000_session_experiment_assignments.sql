-- Session-stamped experiment attribution (experiment-session-stamped-attribution Phase 1).
-- Stamp every storefront session with the arm(s) it was assigned, server/edge-side off
-- the resolved assignment (sx_variant cookie / resolveExperimentsForRender) — NOT the flaky
-- client experiment_exposure event. Each element:
--   { experiment_id, variant_id, arm: control|variant|holdout, assigned_at, surface }
-- Internal/bot sessions are still stamped (previews/QA stay inspectable); they're excluded
-- at the REPORTING layer, not dropped at write.
ALTER TABLE public.storefront_sessions
  ADD COLUMN IF NOT EXISTS experiment_assignments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Containment index — attribution filters sessions by "stamped to experiment X"
-- (experiment_assignments @> '[{"experiment_id":"…"}]').
CREATE INDEX IF NOT EXISTS storefront_sessions_experiment_assignments_gin
  ON public.storefront_sessions USING gin (experiment_assignments jsonb_path_ops);
