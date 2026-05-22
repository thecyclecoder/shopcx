-- Lookup customers by phone, normalized to digits-only for both sides.
-- The customers.phone column has historically held mixed formats —
-- E.164 (+18583349198), formatted ((858) 334-9198), digits-only,
-- dashed (858-334-9198) — depending on which sync path wrote the row.
-- Twilio sends inbound `From` in E.164, so a literal column match
-- silently misses any row stored in a different format.
--
-- This RPC strips non-digits on both the column value and the
-- argument, then compares. Lets the marketing STOP webhook (and any
-- future phone-based lookup) hit every linked row regardless of
-- stored format.

CREATE OR REPLACE FUNCTION find_subscribed_customers_by_phone(
  p_workspace_id UUID,
  p_phone TEXT
)
RETURNS TABLE (
  id UUID,
  workspace_id UUID,
  shopify_customer_id TEXT,
  email TEXT,
  phone TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.workspace_id, c.shopify_customer_id, c.email, c.phone
  FROM customers c
  WHERE c.workspace_id = p_workspace_id
    AND c.sms_marketing_status = 'subscribed'
    AND c.phone IS NOT NULL
    AND regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
$$;

-- Service role + authenticated can call. (Not exposed to anon.)
REVOKE ALL ON FUNCTION find_subscribed_customers_by_phone(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_subscribed_customers_by_phone(UUID, TEXT) TO service_role, authenticated;
