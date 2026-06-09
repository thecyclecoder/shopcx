-- Let customer_payment_methods hold Shopify Payments–managed cards, not
-- just Braintree-vaulted ones. Background: the table was born
-- Braintree-only (braintree_customer_id + braintree_payment_method_token
-- both NOT NULL), and provider was later added defaulting to 'braintree'
-- with the note "if/when we sync Shopify payment methods, those rows must
-- set 'shopify'." This migration makes that sync possible.
--
-- Shopify/Appstle subscriptions are charged through Shopify, so their
-- cards have NO Braintree token — only a Shopify CustomerPaymentMethod
-- gid. We relax the two Braintree NOT NULLs and add the Shopify handle.
-- provider='shopify' rows are inert to every Braintree charge path
-- (those filter by token / provider), so this is additive and safe.

ALTER TABLE public.customer_payment_methods
  ALTER COLUMN braintree_customer_id DROP NOT NULL,
  ALTER COLUMN braintree_payment_method_token DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS shopify_payment_method_id TEXT;

-- One row per Shopify payment method per workspace. Lets the sync upsert
-- on conflict instead of duplicating on every webhook re-fire.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_payment_methods_shopify_pm
  ON public.customer_payment_methods (workspace_id, shopify_payment_method_id)
  WHERE shopify_payment_method_id IS NOT NULL;

-- Guardrail: a row must be reachable by at least one provider handle.
ALTER TABLE public.customer_payment_methods
  DROP CONSTRAINT IF EXISTS customer_payment_methods_handle_present;
ALTER TABLE public.customer_payment_methods
  ADD CONSTRAINT customer_payment_methods_handle_present
  CHECK (braintree_payment_method_token IS NOT NULL OR shopify_payment_method_id IS NOT NULL);
