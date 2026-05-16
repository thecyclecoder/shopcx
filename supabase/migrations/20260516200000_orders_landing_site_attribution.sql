-- ─────────────────────────────────────────────────────────────────
-- Direct Shopify-webhook landing_site + UTM attribution on orders.
--
-- Previously we relied on Klaviyo's Placed Order event import (cron)
-- to populate attribution via klaviyo_events.attributed_utm_campaign.
-- That works but has cron lag — orders placed minutes ago show $0
-- on the campaign detail until the import runs.
--
-- Shopify's orders/create webhook payload already carries the
-- session-entry URL in `landing_site`. Capturing it directly gives
-- us instant attribution + defense-in-depth alongside the Klaviyo
-- path.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS landing_site         TEXT,
  ADD COLUMN IF NOT EXISTS referring_site       TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_term     TEXT;

COMMENT ON COLUMN public.orders.landing_site IS
  'Raw landing_site from Shopify orders/create webhook — the URL the customer first hit in this session, including any UTM params.';
COMMENT ON COLUMN public.orders.attributed_utm_campaign IS
  'Top-level utm_campaign extracted from landing_site at webhook time. For SMS campaigns this is the sms_campaigns.id.';

-- Partial index for the hot attribution-join query on campaign detail.
-- Filter keeps the index small — most orders have no UTM.
CREATE INDEX IF NOT EXISTS orders_attributed_utm_campaign_idx
  ON public.orders (workspace_id, attributed_utm_campaign, created_at DESC)
  WHERE attributed_utm_campaign IS NOT NULL;
