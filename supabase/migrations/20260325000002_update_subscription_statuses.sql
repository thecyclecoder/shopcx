-- Bulk update customer subscription_status from their subscriptions
-- One SQL query instead of thousands of individual queries
CREATE OR REPLACE FUNCTION public.update_customer_subscription_statuses(ws_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
  WITH customer_sub_status AS (
    SELECT
      s.customer_id,
      CASE
        WHEN bool_or(s.status = 'active') THEN 'active'
        WHEN bool_or(s.status = 'paused') THEN 'paused'
        ELSE 'cancelled'
      END AS derived_status
    FROM public.subscriptions s
    WHERE s.workspace_id = ws_id
      AND s.customer_id IS NOT NULL
    GROUP BY s.customer_id
  ),
  updated AS (
    UPDATE public.customers c
    SET subscription_status = css.derived_status,
        updated_at = now()
    FROM customer_sub_status css
    WHERE c.id = css.customer_id
      AND c.workspace_id = ws_id
      AND c.subscription_status IS DISTINCT FROM css.derived_status
    RETURNING c.id
  )
  SELECT count(*)::integer FROM updated;
$$;
