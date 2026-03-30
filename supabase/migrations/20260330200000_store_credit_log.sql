CREATE TABLE store_credit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  shopify_customer_id text NOT NULL,
  type text NOT NULL,                -- 'credit' or 'debit'
  amount numeric NOT NULL,           -- always positive, type indicates direction
  currency text NOT NULL DEFAULT 'USD',
  reason text,                       -- free text note from admin
  issued_by uuid NOT NULL REFERENCES workspace_members(id),
  issued_by_name text NOT NULL,      -- display_name snapshot at time of issue
  ticket_id uuid REFERENCES tickets(id),
  subscription_id text,
  shopify_transaction_id text,
  balance_after numeric,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE store_credit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_read" ON store_credit_log
  FOR SELECT USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "service_role_all" ON store_credit_log
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_store_credit_log_customer ON store_credit_log (workspace_id, customer_id);
CREATE INDEX idx_store_credit_log_ticket ON store_credit_log (ticket_id) WHERE ticket_id IS NOT NULL;
