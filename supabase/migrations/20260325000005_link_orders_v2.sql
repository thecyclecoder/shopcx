-- Upgraded link_orders_to_customers: shopify_customer_id first, email fallback
CREATE OR REPLACE FUNCTION public.link_orders_to_customers(ws_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE linked INTEGER := 0; n INTEGER;
BEGIN
  -- Pass 1: match by shopify_customer_id (primary)
  WITH updated AS (
    UPDATE public.orders o
    SET customer_id = c.id
    FROM public.customers c
    WHERE o.workspace_id = ws_id
      AND o.customer_id IS NULL
      AND c.workspace_id = ws_id
      AND o.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = c.shopify_customer_id
    RETURNING o.id
  )
  SELECT count(*) INTO n FROM updated;
  linked := linked + n;

  -- Pass 2: match by email (fallback for remaining unlinked)
  WITH updated AS (
    UPDATE public.orders o
    SET customer_id = c.id
    FROM public.customers c
    WHERE o.workspace_id = ws_id
      AND o.customer_id IS NULL
      AND c.workspace_id = ws_id
      AND o.email IS NOT NULL
      AND lower(o.email) = lower(c.email)
    RETURNING o.id
  )
  SELECT count(*) INTO n FROM updated;
  linked := linked + n;

  RETURN linked;
END $$;

-- Link orders to subscriptions via customer match + recurring source
CREATE OR REPLACE FUNCTION public.link_orders_to_subscriptions(ws_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
  WITH updated AS (
    UPDATE public.orders o
    SET subscription_id = s.id
    FROM public.subscriptions s
    WHERE o.workspace_id = ws_id
      AND o.subscription_id IS NULL
      AND s.workspace_id = ws_id
      AND o.customer_id IS NOT NULL
      AND o.customer_id = s.customer_id
      AND o.order_type = 'recurring'
    RETURNING o.id
  )
  SELECT count(*)::integer FROM updated;
$$;
