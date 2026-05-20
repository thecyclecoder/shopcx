-- Transactions — every Braintree charge attempt.
--
-- Sits between subscriptions / payment_methods on the input side and
-- orders / dunning on the output side. One row per attempt; renewals,
-- initial checkouts, and dunning retries all go here. Lets us answer
-- "did this customer try to pay and what happened" without untangling
-- the orders ledger or scraping Braintree's API.
--
-- Lifecycle:
--   pending    — row inserted before transaction.sale fires; status
--                until we have a real response. Mid-flight crash leaves
--                a useful "started but never confirmed" record.
--   succeeded  — Braintree returned success=true.
--   failed     — Braintree returned a processor decline or API error.
--   refunded   — full refund issued later.
--   voided     — voided before settlement.

CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,

  -- Subscription this charge is for. NULL for initial-checkout charges
  -- because the customer's brand-new sub row is created in the same
  -- transaction (we patch the FK once both exist).
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,

  -- Payment method used. RESTRICT instead of CASCADE so we never lose a
  -- transaction record because the customer deleted their card.
  payment_method_id UUID REFERENCES public.customer_payment_methods(id) ON DELETE RESTRICT,

  -- Order produced by this charge. Set after the sale succeeds + order
  -- row is inserted. Nullable so we can record failed attempts too.
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,

  -- 'initial_checkout' — created at /api/checkout time
  -- 'renewal'          — created by the renewal cron
  -- 'dunning_retry'    — created by dunning attempts (existing system)
  -- 'manual'           — created by an agent through the dashboard
  type TEXT NOT NULL DEFAULT 'initial_checkout'
    CHECK (type IN ('initial_checkout', 'renewal', 'dunning_retry', 'manual')),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'voided')),

  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',

  -- Braintree handles
  braintree_transaction_id TEXT,
  braintree_payment_method_token TEXT,
  braintree_customer_id TEXT,

  -- Decline reason / API error / processor response. Plain text so
  -- agents can read it from the dashboard without a Braintree login.
  processor_response_code TEXT,
  processor_response_text TEXT,
  error_message TEXT,

  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,            -- set when Braintree settles
  refunded_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_workspace_customer
  ON public.transactions(workspace_id, customer_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_subscription
  ON public.transactions(subscription_id, attempted_at DESC)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON public.transactions(workspace_id, status, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_braintree_id
  ON public.transactions(braintree_transaction_id)
  WHERE braintree_transaction_id IS NOT NULL;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read transactions" ON public.transactions;
CREATE POLICY "Authenticated read transactions"
  ON public.transactions FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on transactions" ON public.transactions;
CREATE POLICY "Service role full on transactions"
  ON public.transactions FOR ALL TO service_role
  USING (true) WITH CHECK (true);
