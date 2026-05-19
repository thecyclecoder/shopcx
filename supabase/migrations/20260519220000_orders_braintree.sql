-- Native checkout fields on orders
--
-- Until now `orders` was a one-way mirror of Shopify. Native Braintree
-- checkout puts us on the originating side, so we need somewhere to
-- store the transaction + vaulted card token for future renewals.
--
-- shopify_order_id was NOT NULL because every order originated in
-- Shopify. With native checkout that's no longer true — drop the
-- constraint. The UNIQUE(workspace_id, shopify_order_id) index still
-- guards against duplicate Shopify imports because Postgres treats
-- NULL as distinct in unique indexes.

ALTER TABLE public.orders
  ALTER COLUMN shopify_order_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS braintree_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS braintree_payment_method_token TEXT,
  ADD COLUMN IF NOT EXISTS braintree_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS cart_token TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_braintree_transaction
  ON public.orders(braintree_transaction_id)
  WHERE braintree_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_cart_token
  ON public.orders(cart_token)
  WHERE cart_token IS NOT NULL;
