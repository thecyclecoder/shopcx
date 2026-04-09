-- Crisis Management tables

CREATE TABLE crisis_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft, active, paused, resolved
  affected_variant_id TEXT NOT NULL,
  affected_sku TEXT,
  affected_product_title TEXT,
  default_swap_variant_id TEXT,
  default_swap_title TEXT,
  available_flavor_swaps JSONB DEFAULT '[]',
  available_product_swaps JSONB DEFAULT '[]',
  tier2_coupon_code TEXT,
  tier2_coupon_percent INTEGER DEFAULT 20,
  expected_restock_date DATE,
  lead_time_days INTEGER DEFAULT 7,
  tier_wait_days INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_crisis_events_workspace ON crisis_events(workspace_id, status);

ALTER TABLE crisis_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_read" ON crisis_events FOR SELECT USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
);
CREATE POLICY "service_all" ON crisis_events FOR ALL USING (auth.role() = 'service_role');

CREATE TABLE crisis_customer_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_id UUID NOT NULL REFERENCES crisis_events(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  subscription_id UUID REFERENCES subscriptions(id),
  customer_id UUID REFERENCES customers(id),
  segment TEXT NOT NULL,  -- 'berry_only' or 'berry_plus'
  original_item JSONB,
  current_tier INTEGER DEFAULT 0,
  tier1_sent_at TIMESTAMPTZ,
  tier1_response TEXT,
  tier1_swapped_to JSONB,
  tier2_sent_at TIMESTAMPTZ,
  tier2_response TEXT,
  tier2_swapped_to JSONB,
  tier2_coupon_applied BOOLEAN DEFAULT false,
  tier3_sent_at TIMESTAMPTZ,
  tier3_response TEXT,
  paused_at TIMESTAMPTZ,
  auto_resume BOOLEAN DEFAULT false,
  removed_item_at TIMESTAMPTZ,
  auto_readd BOOLEAN DEFAULT false,
  cancelled BOOLEAN DEFAULT false,
  cancel_date TIMESTAMPTZ,
  ticket_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_crisis_actions_crisis ON crisis_customer_actions(crisis_id, current_tier);
CREATE INDEX idx_crisis_actions_customer ON crisis_customer_actions(customer_id);
CREATE INDEX idx_crisis_actions_sub ON crisis_customer_actions(subscription_id);

ALTER TABLE crisis_customer_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_read" ON crisis_customer_actions FOR SELECT USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
);
CREATE POLICY "service_all" ON crisis_customer_actions FOR ALL USING (auth.role() = 'service_role');
