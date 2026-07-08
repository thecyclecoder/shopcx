-- sol_replay_runs — audit-trail table for the pre-Sol shadow-baseline replays
-- authored by scripts/replay-tickets-through-sol.ts. One row per replay run;
-- rows are INSERT-only (never mutated) so the audit trail is preserved
-- across re-runs of the same window.
--
-- Spec: docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md § Phase 4
-- Milestone parent: goals/sol-ticket-direction-then-cheap-execution M5

CREATE TABLE IF NOT EXISTS public.sol_replay_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sample_size INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  -- results[] shape: { ticket_id: uuid, estimated_cents: number,
  --                    direction_estimated_cents: number,
  --                    per_turn_estimated_cents: number,
  --                    turn_count: number }
  results JSONB NOT NULL DEFAULT '[]',
  total_estimated_cents BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sol_replay_runs_ws_run_at
  ON public.sol_replay_runs(workspace_id, run_at DESC);

ALTER TABLE public.sol_replay_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role full access on sol_replay_runs"
    ON public.sol_replay_runs FOR ALL TO service_role
    USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Workspace members can read sol_replay_runs"
    ON public.sol_replay_runs FOR SELECT TO authenticated
    USING (
      workspace_id IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
