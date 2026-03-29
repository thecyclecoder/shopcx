-- Dunning system: payment failure recovery with card rotation + payday retries

-- Payment failure attempts log
CREATE TABLE public.payment_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  subscription_id UUID REFERENCES subscriptions(id),
  shopify_contract_id TEXT NOT NULL,
  billing_attempt_id TEXT,
  payment_method_last4 TEXT,
  payment_method_id TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('initial', 'card_rotation', 'payday_retry', 'new_card_retry')),
  succeeded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_payment_failures_sub ON payment_failures(workspace_id, shopify_contract_id, created_at DESC);
CREATE INDEX idx_payment_failures_customer ON payment_failures(customer_id, succeeded);

-- Dunning cycle tracking per subscription per billing cycle
CREATE TABLE public.dunning_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id),
  shopify_contract_id TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  cycle_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('active', 'skipped', 'paused', 'recovered', 'exhausted')),
  cards_tried TEXT[] DEFAULT '{}',
  payment_update_sent BOOLEAN DEFAULT false,
  payment_update_sent_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  billing_attempt_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_dunning_cycles_active ON dunning_cycles(workspace_id, status, customer_id);
CREATE UNIQUE INDEX idx_dunning_cycles_contract ON dunning_cycles(workspace_id, shopify_contract_id, cycle_number);

-- Workspace dunning settings
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_enabled BOOLEAN DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_max_card_rotations INTEGER DEFAULT 6;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_payday_retry_enabled BOOLEAN DEFAULT true;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_cycle_1_action TEXT DEFAULT 'skip';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_cycle_2_action TEXT DEFAULT 'pause';

-- RLS policies
ALTER TABLE payment_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_cycles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view payment failures in their workspace"
  ON payment_failures FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on payment_failures"
  ON payment_failures FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can view dunning cycles in their workspace"
  ON dunning_cycles FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on dunning_cycles"
  ON dunning_cycles FOR ALL
  USING (true)
  WITH CHECK (true);

-- Grant service_role full access
GRANT ALL ON payment_failures TO service_role;
GRANT ALL ON dunning_cycles TO service_role;
GRANT SELECT ON payment_failures TO authenticated;
GRANT SELECT ON dunning_cycles TO authenticated;
