-- Efficient batch update of first/last order dates on customers
CREATE OR REPLACE FUNCTION public.update_customer_order_dates(ws_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.customers c
  SET
    first_order_at = sub.first_order,
    last_order_at = sub.last_order,
    updated_at = now()
  FROM (
    SELECT
      customer_id,
      MIN(created_at) AS first_order,
      MAX(created_at) AS last_order
    FROM public.orders
    WHERE workspace_id = ws_id AND customer_id IS NOT NULL
    GROUP BY customer_id
  ) sub
  WHERE c.id = sub.customer_id
    AND c.workspace_id = ws_id;
$$;
