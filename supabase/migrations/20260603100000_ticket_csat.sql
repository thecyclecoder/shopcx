-- CSAT — one row per ticket-closure survey. Trigger: ticket_csat
-- Inngest fn fires 24h after ticket/closed, sends an email with 5
-- star buttons that deep-link into /csat/{ticketId}?score=N. Customer
-- confirms + optionally leaves a comment. After submit, Haiku
-- classifies the resolution_category so the dashboard can slice
-- 'service CSAT' (excluding policy denials) from the headline number.
CREATE TABLE IF NOT EXISTS ticket_csat (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id              UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  customer_id            UUID REFERENCES customers(id) ON DELETE SET NULL,
  rating                 INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment                TEXT,
  -- Haiku classification of WHY the customer rated this way.
  -- Values: resolved / policy_denial / unresolved_failure / mixed / unclear
  resolution_category    TEXT,
  classification_reason  TEXT,
  ai_classified_at       TIMESTAMPTZ,
  -- Loyalty points awarded for completing the survey (regardless of
  -- rating — we're paying for honest feedback, not positive reviews).
  points_awarded         INTEGER NOT NULL DEFAULT 0,
  points_awarded_at      TIMESTAMPTZ,
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id)
);

CREATE INDEX IF NOT EXISTS ticket_csat_workspace_submitted_idx
  ON ticket_csat (workspace_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ticket_csat_workspace_rating_category_idx
  ON ticket_csat (workspace_id, rating, resolution_category);

ALTER TABLE ticket_csat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_csat" ON ticket_csat
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_csat" ON ticket_csat
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
