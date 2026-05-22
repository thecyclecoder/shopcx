-- Sibling to find_subscribed_customers_by_phone: returns matches
-- regardless of sms_marketing_status. Used by the START / opt-in
-- handler, which needs to flip 'unsubscribed' rows back to
-- 'subscribed' — the original RPC's subscribed-only filter would
-- always return zero for those.
--
-- Same digit-normalized phone comparison as the original so any stored
-- format ((858) 334-9198, +18583349198, etc.) still matches the
-- Twilio inbound From.

CREATE OR REPLACE FUNCTION find_customers_by_phone(
  p_workspace_id UUID,
  p_phone TEXT
)
RETURNS TABLE (
  id UUID,
  workspace_id UUID,
  shopify_customer_id TEXT,
  email TEXT,
  phone TEXT,
  sms_marketing_status TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.workspace_id, c.shopify_customer_id, c.email, c.phone, c.sms_marketing_status
  FROM customers c
  WHERE c.workspace_id = p_workspace_id
    AND c.phone IS NOT NULL
    AND regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
$$;

REVOKE ALL ON FUNCTION find_customers_by_phone(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_customers_by_phone(UUID, TEXT) TO service_role, authenticated;
