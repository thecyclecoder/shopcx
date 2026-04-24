-- Track billing error codes with terminal classification
-- Auto-populated from payment_failures, admin can toggle is_terminal in settings

CREATE TABLE public.dunning_error_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  error_code TEXT NOT NULL,
  error_message TEXT,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, error_code)
);

CREATE INDEX idx_dunning_error_codes_ws ON dunning_error_codes(workspace_id);

ALTER TABLE dunning_error_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view error codes in their workspace"
  ON dunning_error_codes FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on dunning_error_codes"
  ON dunning_error_codes FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT ALL ON dunning_error_codes TO service_role;
GRANT SELECT ON dunning_error_codes TO authenticated;

-- Also update dunning_cycles to allow 'rotating' and 'retrying' status
-- and add terminal_error_code field
ALTER TABLE dunning_cycles
  DROP CONSTRAINT IF EXISTS dunning_cycles_status_check;

ALTER TABLE dunning_cycles
  ADD CONSTRAINT dunning_cycles_status_check
  CHECK (status IN ('active', 'rotating', 'retrying', 'skipped', 'paused', 'recovered', 'exhausted'));

ALTER TABLE dunning_cycles ADD COLUMN IF NOT EXISTS terminal_error_code TEXT;

-- Seed known terminal error codes for existing workspaces
INSERT INTO dunning_error_codes (workspace_id, error_code, error_message, is_terminal, occurrence_count, first_seen_at, last_seen_at)
SELECT w.id, codes.error_code, codes.error_message, codes.is_terminal, 0, now(), now()
FROM workspaces w
CROSS JOIN (VALUES
  ('payment_method_not_found', 'Payment method was revoked', true),
  ('card_number_incorrect', 'Your card number is incorrect.', true),
  ('expired_payment_method', 'Your card has expired.', true),
  ('invalid_payment_method', 'Invalid account.', true),
  ('purchase_type_not_supported', 'Your card does not support this type of purchase.', true),
  ('fraud_suspected', 'Your card was declined.', false),
  ('payment_method_declined', 'Your card was declined.', false),
  ('insufficient_funds', 'Your card has insufficient funds.', false),
  ('unexpected_error', 'Billing attempt could not be processed', false)
) AS codes(error_code, error_message, is_terminal)
WHERE w.dunning_enabled = true
ON CONFLICT (workspace_id, error_code) DO NOTHING;
