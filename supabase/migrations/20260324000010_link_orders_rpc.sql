-- Backfill order customer_id by matching email
CREATE OR REPLACE FUNCTION public.link_orders_to_customers(ws_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
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
  SELECT count(*)::integer FROM updated;
$$;
