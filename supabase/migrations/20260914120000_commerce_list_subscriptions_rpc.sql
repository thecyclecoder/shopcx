-- commerce-sdk-display-operations Phase 1 — subscription list RPC.
--
-- Projects, per row, the subscription + its latest renewal order + the upcoming
-- (projected) renewal in one round trip so `src/lib/commerce/subscription.ts`
-- can render a subscription list without an O(N) fan-out. Cursor-paginated on
-- (updated_at DESC, id DESC) so the SDK can walk past PostgREST's 1000-row cap.
--
-- Idempotent (CREATE OR REPLACE). Read-only (LANGUAGE sql STABLE).
--
-- Callers:
--   - src/lib/commerce/subscription.ts::listSubscriptions
--   - src/lib/commerce/subscription.ts::listSubscriptionsByCustomer
--   - scripts/_probe-commerce-display-subs.ts (verification probe)

CREATE OR REPLACE FUNCTION commerce_list_subscriptions(
  p_workspace_id uuid,
  p_status text DEFAULT NULL,
  p_last_payment_status text DEFAULT NULL,
  p_is_internal boolean DEFAULT NULL,
  p_comp boolean DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_cursor_updated_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(
  sub jsonb,
  latest_order jsonb,
  upcoming_order jsonb
)
LANGUAGE sql
STABLE
AS $$
  WITH page AS (
    SELECT s.*
    FROM subscriptions s
    WHERE s.workspace_id = p_workspace_id
      AND (p_status IS NULL OR s.status = p_status)
      AND (p_last_payment_status IS NULL OR s.last_payment_status = p_last_payment_status)
      AND (p_is_internal IS NULL OR s.is_internal = p_is_internal)
      AND (p_comp IS NULL OR s.comp = p_comp)
      AND (p_customer_id IS NULL OR s.customer_id = p_customer_id)
      AND (
        p_cursor_updated_at IS NULL
        OR p_cursor_id IS NULL
        OR (s.updated_at, s.id) < (p_cursor_updated_at, p_cursor_id)
      )
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT GREATEST(1, LEAST(1000, p_limit))
  )
  SELECT
    jsonb_build_object(
      'id', p.id,
      'workspace_id', p.workspace_id,
      'customer_id', p.customer_id,
      'shopify_contract_id', p.shopify_contract_id,
      'status', p.status,
      'is_internal', p.is_internal,
      'comp', p.comp,
      'billing_interval', p.billing_interval,
      'billing_interval_count', p.billing_interval_count,
      'next_billing_date', p.next_billing_date,
      'last_payment_status', p.last_payment_status,
      'items', p.items,
      'delivery_price_cents', p.delivery_price_cents,
      'shipping_address', p.shipping_address,
      'shipping_protection_added', p.shipping_protection_added,
      'shipping_protection_amount_cents', p.shipping_protection_amount_cents,
      'applied_discounts', p.applied_discounts,
      'pricing_offer_id', p.pricing_offer_id,
      'payment_method_id', p.payment_method_id,
      'created_at', p.created_at,
      'updated_at', p.updated_at
    ) AS sub,
    (
      SELECT jsonb_build_object(
        'id', o.id,
        'order_number', o.order_number,
        'financial_status', o.financial_status,
        'delivery_status', o.delivery_status,
        'total_cents', o.total_cents,
        'created_at', o.created_at,
        'delivered_at', o.delivered_at
      )
      FROM orders o
      WHERE o.subscription_id = p.id
        AND o.workspace_id = p.workspace_id
      ORDER BY o.created_at DESC
      LIMIT 1
    ) AS latest_order,
    jsonb_build_object(
      'next_billing_date', p.next_billing_date
    ) AS upcoming_order
  FROM page p;
$$;

COMMENT ON FUNCTION commerce_list_subscriptions IS
  'commerce-sdk-display-operations Phase 1. Cursor-paginated (updated_at DESC, id DESC) subscription list projecting sub + latest_order + upcoming_order in one round trip. Consumed by src/lib/commerce/subscription.ts.';
