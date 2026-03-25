-- Add shopify_customer_id and subscription_id to orders for ID-first lookups
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_customer_id TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_shopify_customer ON public.orders(workspace_id, shopify_customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_subscription ON public.orders(subscription_id);
