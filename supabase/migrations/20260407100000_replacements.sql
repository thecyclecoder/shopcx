-- Replacement orders table
CREATE TABLE replacements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  customer_id UUID REFERENCES customers(id),
  original_order_id UUID REFERENCES orders(id),
  original_order_number TEXT,
  replacement_order_id UUID REFERENCES orders(id),
  shopify_draft_order_id TEXT,
  shopify_replacement_order_id TEXT,
  shopify_replacement_order_name TEXT,
  reason TEXT NOT NULL,  -- refused, delivery_error, missing_items, damaged_items, wrong_address, carrier_lost, not_received
  reason_detail TEXT,
  items JSONB,           -- [{title, variantId, quantity, type: "missing"|"damaged"|"all"}]
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, address_confirmed, created, shipped, completed, denied
  customer_error BOOLEAN NOT NULL DEFAULT false,
  ticket_id UUID REFERENCES tickets(id),
  address_validated BOOLEAN DEFAULT false,
  validated_address JSONB,
  subscription_id UUID REFERENCES subscriptions(id),
  subscription_adjusted BOOLEAN DEFAULT false,
  new_next_billing_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_replacements_workspace ON replacements(workspace_id);
CREATE INDEX idx_replacements_customer ON replacements(customer_id);
CREATE INDEX idx_replacements_status ON replacements(status);
CREATE INDEX idx_replacements_ticket ON replacements(ticket_id);
CREATE INDEX idx_replacements_original_order ON replacements(original_order_id);

-- RLS
ALTER TABLE replacements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_read" ON replacements FOR SELECT USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
);
CREATE POLICY "service_all" ON replacements FOR ALL USING (auth.role() = 'service_role');
