-- payment_methods need a provider flag so renewal/dunning routes the
-- right way:
--   - 'braintree' → storefront-vaulted card; charge via Braintree
--     (internal subscriptions, where is_internal=true)
--   - 'shopify'   → Shopify Payments–managed card; charge via Shopify
--     (legacy Appstle subscriptions)
--
-- Mixing them is fatal — Braintree tokens are nonsense to Shopify and
-- vice versa, so dunning's card-rotation logic would burn retries
-- attempting an impossible charge. The flag is read on every
-- attempt-billing path.
--
-- Default 'braintree' because that's the only writer today
-- (/api/checkout); if/when we sync Shopify payment methods to this
-- table, those rows must set 'shopify' explicitly.

ALTER TABLE public.customer_payment_methods
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'braintree';

CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_provider
  ON public.customer_payment_methods (customer_id, provider, is_default);
