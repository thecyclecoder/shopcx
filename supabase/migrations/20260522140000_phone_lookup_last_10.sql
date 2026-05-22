-- Update phone-normalized lookup RPCs to compare the LAST 10 digits.
-- The previous version stripped non-digits but did a full-string
-- match, which missed when the stored column omits the +1 US country
-- code (e.g. "(858) 334-9198" = 10 digits) and the Twilio inbound
-- includes it ("+18583349198" = 11 digits).
--
-- Last-10-digit comparison covers every US format we've seen:
--   +18583349198, 18583349198 → 11 → last10 = 8583349198
--   (858) 334-9198, 858-334-9198, 8583349198 → 10 → last10 = 8583349198
--
-- Trade-off: non-US numbers sharing the same trailing 10 digits would
-- match. For the marketing shortcode (US-only) this is fine.

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
    AND right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10)
    AND length(regexp_replace(c.phone, '\D', '', 'g')) >= 10;
$$;

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
    AND right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10)
    AND length(regexp_replace(c.phone, '\D', '', 'g')) >= 10;
$$;
