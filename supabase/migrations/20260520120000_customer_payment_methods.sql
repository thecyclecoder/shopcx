-- Customer payment methods layer
--
-- Pattern: vault FIRST, then charge against the saved token. The
-- payment-method row is the source of truth — orders reference a
-- token that lives there, not the other way around. Lets us:
--   - Run subscription renewals later by looking up the default
--     active method per customer
--   - Survive mid-flight transaction failures (the card is already
--     vaulted, so a retry doesn't ask the customer to re-enter card data)
--   - Handle multi-card scenarios cleanly (default flag, status
--     lifecycle, replacement when the customer adds a new card)
--
-- Braintree customer linkage moves onto customers.braintree_customer_id
-- so we reuse one BT customer per shopcx customer instead of creating
-- a new one on every checkout.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS braintree_customer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_braintree_customer_id
  ON public.customers(braintree_customer_id)
  WHERE braintree_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.customer_payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,

  -- Braintree handles
  braintree_customer_id TEXT NOT NULL,
  braintree_payment_method_token TEXT NOT NULL UNIQUE,

  -- What kind of payment instrument this is. Same set Braintree
  -- exposes via paymentInstrumentType, normalized to snake_case.
  payment_type TEXT NOT NULL DEFAULT 'credit_card'
    CHECK (payment_type IN (
      'credit_card', 'paypal_account', 'apple_pay_card',
      'google_pay_card', 'venmo_account', 'us_bank_account', 'unknown'
    )),

  -- Display-only fields. Charges happen via braintree_payment_method_token;
  -- these surface "Visa ending 4242, exp 12/26" in the dashboard + portal
  -- without hitting Braintree on every page render.
  card_brand TEXT,                 -- "Visa", "Mastercard", "Amex" (or null for non-card types)
  last4 TEXT,
  expiration_month TEXT,           -- 2-char e.g. "07"
  expiration_year TEXT,            -- 4-char e.g. "2026"

  is_default BOOLEAN NOT NULL DEFAULT false,

  -- 'active'    — usable for new charges
  -- 'expired'   — passed expiration_year/month (set by a periodic sweep)
  -- 'removed'   — customer or admin deleted; do not charge again
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'removed')),

  -- Optional pointer back to the cart token that created this method,
  -- so we can audit "which checkout produced this card".
  created_from_cart_token TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_customer
  ON public.customer_payment_methods(workspace_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_default
  ON public.customer_payment_methods(workspace_id, customer_id)
  WHERE is_default = true AND status = 'active';

ALTER TABLE public.customer_payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read customer_payment_methods" ON public.customer_payment_methods;
CREATE POLICY "Authenticated read customer_payment_methods"
  ON public.customer_payment_methods FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on customer_payment_methods" ON public.customer_payment_methods;
CREATE POLICY "Service role full on customer_payment_methods"
  ON public.customer_payment_methods FOR ALL TO service_role
  USING (true) WITH CHECK (true);
