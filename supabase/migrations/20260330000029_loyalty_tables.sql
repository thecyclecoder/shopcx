-- Loyalty system tables: members, transactions, redemptions, settings (native engine)

-- Loyalty members
CREATE TABLE loyalty_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  customer_id uuid REFERENCES customers(id),
  shopify_customer_id text,
  email text,
  points_balance integer NOT NULL DEFAULT 0,
  points_earned integer NOT NULL DEFAULT 0,
  points_spent integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'native',  -- 'native' or 'import'
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(workspace_id, shopify_customer_id)
);

-- Points transactions (append-only ledger)
CREATE TABLE loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  member_id uuid NOT NULL REFERENCES loyalty_members(id) ON DELETE CASCADE,
  points_change integer NOT NULL,   -- positive = earned, negative = spent
  type text NOT NULL,               -- 'earning', 'spending', 'adjustment', 'import', 'refund', 'chargeback'
  description text,
  order_id text,                    -- Shopify order ID if from purchase/refund
  shopify_discount_id text,         -- Shopify discount GID if from redemption
  created_at timestamptz DEFAULT now()
);

-- Reward redemptions
CREATE TABLE loyalty_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  member_id uuid NOT NULL REFERENCES loyalty_members(id) ON DELETE CASCADE,
  reward_tier text NOT NULL,        -- e.g., "$5", "$10", "$15"
  points_spent integer NOT NULL,
  discount_code text NOT NULL,      -- the generated Shopify code
  shopify_discount_id text,         -- Shopify discount node GID
  discount_value numeric NOT NULL,  -- 5, 10, or 15
  status text NOT NULL DEFAULT 'active', -- 'active', 'used', 'expired'
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Loyalty settings per workspace
CREATE TABLE loyalty_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  enabled boolean NOT NULL DEFAULT false,
  -- Earning
  points_per_dollar integer NOT NULL DEFAULT 10,
  -- Conversion display
  points_per_dollar_value integer NOT NULL DEFAULT 100,  -- 100 points = $1
  -- Redemption tiers (JSONB array for flexibility)
  redemption_tiers jsonb NOT NULL DEFAULT '[
    {"label": "$5 Off", "points_cost": 500, "discount_value": 5},
    {"label": "$10 Off", "points_cost": 1000, "discount_value": 10},
    {"label": "$15 Off", "points_cost": 1500, "discount_value": 15}
  ]'::jsonb,
  -- Coupon settings
  coupon_applies_to text NOT NULL DEFAULT 'both',  -- 'one_time', 'subscription', 'both'
  coupon_combines_product boolean NOT NULL DEFAULT true,
  coupon_combines_shipping boolean NOT NULL DEFAULT true,
  coupon_combines_order boolean NOT NULL DEFAULT false,
  coupon_expiry_days integer NOT NULL DEFAULT 90,
  -- Order total deductions (what to EXCLUDE from points-qualifying amount)
  exclude_tax boolean NOT NULL DEFAULT true,
  exclude_discounts boolean NOT NULL DEFAULT true,
  exclude_shipping boolean NOT NULL DEFAULT true,
  exclude_shipping_protection boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_loyalty_members_workspace ON loyalty_members(workspace_id);
CREATE INDEX idx_loyalty_members_customer ON loyalty_members(customer_id);
CREATE INDEX idx_loyalty_members_shopify ON loyalty_members(workspace_id, shopify_customer_id);
CREATE INDEX idx_loyalty_members_email ON loyalty_members(workspace_id, email);
CREATE INDEX idx_loyalty_transactions_member ON loyalty_transactions(member_id);
CREATE INDEX idx_loyalty_transactions_workspace ON loyalty_transactions(workspace_id);
CREATE INDEX idx_loyalty_transactions_created ON loyalty_transactions(workspace_id, created_at DESC);
CREATE INDEX idx_loyalty_transactions_order ON loyalty_transactions(workspace_id, order_id);
CREATE INDEX idx_loyalty_redemptions_member ON loyalty_redemptions(member_id);
CREATE INDEX idx_loyalty_redemptions_workspace ON loyalty_redemptions(workspace_id);
CREATE INDEX idx_loyalty_redemptions_code ON loyalty_redemptions(discount_code);

-- RLS policies
ALTER TABLE loyalty_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_settings ENABLE ROW LEVEL SECURITY;

-- Authenticated users: SELECT only (workspace-scoped)
CREATE POLICY "loyalty_members_select" ON loyalty_members
  FOR SELECT TO authenticated
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
    WHERE wm.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "loyalty_transactions_select" ON loyalty_transactions
  FOR SELECT TO authenticated
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
    WHERE wm.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "loyalty_redemptions_select" ON loyalty_redemptions
  FOR SELECT TO authenticated
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
    WHERE wm.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "loyalty_settings_select" ON loyalty_settings
  FOR SELECT TO authenticated
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
    WHERE wm.user_id = (SELECT auth.uid())
  ));

-- Service role: full access
CREATE POLICY "loyalty_members_service" ON loyalty_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "loyalty_transactions_service" ON loyalty_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "loyalty_redemptions_service" ON loyalty_redemptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "loyalty_settings_service" ON loyalty_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
