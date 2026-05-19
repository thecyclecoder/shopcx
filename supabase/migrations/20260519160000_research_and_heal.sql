-- Research & Heal — auto-recovery for AI-flagged tickets.
-- See RESEARCH-AND-HEAL.md for the full design.

CREATE TABLE IF NOT EXISTS ticket_research_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id           UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  recipe_slug         TEXT NOT NULL,
  recipe_version      INTEGER NOT NULL DEFAULT 1,
  ran_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  findings            JSONB NOT NULL DEFAULT '[]'::jsonb,
  gaps                JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by        TEXT NOT NULL,           -- 'ai_analysis' | 'manual' | 'heal_reverify'
  source_analysis_id  UUID                     -- if triggered_by='ai_analysis'
);

CREATE INDEX IF NOT EXISTS ticket_research_runs_ticket_idx
  ON ticket_research_runs (ticket_id, ran_at DESC);

CREATE INDEX IF NOT EXISTS ticket_research_runs_workspace_idx
  ON ticket_research_runs (workspace_id, ran_at DESC);

ALTER TABLE ticket_research_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON ticket_research_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS ticket_heal_attempts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id               UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  research_run_id         UUID NOT NULL REFERENCES ticket_research_runs(id) ON DELETE CASCADE,
  gap_id                  TEXT NOT NULL,                  -- stable id from the recipe
  recipe_slug             TEXT NOT NULL,                  -- denormalized for query
  action_type             TEXT NOT NULL,                  -- direct_action handler key
  action_params           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                  TEXT NOT NULL DEFAULT 'pending',
  -- statuses: pending | skipped_idempotent | verified_existing | executed |
  --           failed | verified_closed | verified_still_open
  result                  JSONB,
  error                   TEXT,
  customer_message_sent   BOOLEAN NOT NULL DEFAULT false,
  customer_message_body   TEXT,
  attempted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_by            UUID                            -- user_id (manual) or null (auto)
);

CREATE INDEX IF NOT EXISTS ticket_heal_attempts_ticket_idx
  ON ticket_heal_attempts (ticket_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS ticket_heal_attempts_gap_idx
  ON ticket_heal_attempts (ticket_id, gap_id);

ALTER TABLE ticket_heal_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON ticket_heal_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
