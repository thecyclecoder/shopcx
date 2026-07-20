-- Per-subscription payment method.
--
-- A subscription can pin a specific vaulted Braintree card
-- (customer_payment_methods.id) that the internal renewal scheduler charges.
-- NULL = use the customer's default card (current behavior). Internal subs only;
-- Appstle subs bill through Shopify and can't pin a card here.
--
-- ON DELETE SET NULL: if the pinned card is removed, the sub quietly falls back
-- to the customer's default rather than erroring.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS payment_method_id UUID
  REFERENCES public.customer_payment_methods(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.subscriptions.payment_method_id IS
  'Pinned vaulted Braintree payment method (customer_payment_methods.id) the renewal charges. NULL = customer default. Internal subs only.';
