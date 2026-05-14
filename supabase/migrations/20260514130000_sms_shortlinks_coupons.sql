-- ─────────────────────────────────────────────────────────────────
-- Phase 2 for text marketing: shortlinks + campaign coupons.
--
-- Shortlinks:
--   workspaces.shortlink_domain      — admin-configured custom domain
--                                     (e.g. sprfd.co) that resolves
--                                     shortlink slugs via middleware.
--   marketing_shortlinks             — one row per generated short URL.
--                                     Each text campaign with
--                                     shortlink_target_url set gets a
--                                     row with a 6-char base32 slug.
--   marketing_shortlink_clicks       — per-click audit. Stamps device,
--                                     country, and recipient for
--                                     campaign attribution.
--
-- Campaign coupons:
--   Extends sms_campaigns with coupon-related columns. One shared code
--   per campaign (e.g. MAYBLAST20). Created in Shopify at schedule
--   time via discountCodeBasicCreate, disabled by a daily cron after
--   coupon_expires_days_after_send to keep the active-code count low.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS shortlink_domain TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_shortlink_domain_idx
  ON public.workspaces (shortlink_domain) WHERE shortlink_domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.marketing_shortlinks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Slug is the path segment after the domain. Base32 (Crockford),
  -- 6 chars, generated server-side. ~1B slugs of namespace; we'll
  -- never collide in practice but the unique constraint catches the
  -- one-in-a-billion case and lets us retry.
  slug              TEXT NOT NULL,
  target_url        TEXT NOT NULL,

  -- Optional links back to whatever generated the shortlink, so we
  -- can attribute clicks. Both nullable — manual shortlinks (created
  -- by admin without a campaign) are fine.
  campaign_id       UUID REFERENCES public.sms_campaigns(id) ON DELETE SET NULL,

  -- Lightweight stats cached on the row. Real-time per-click data
  -- lives in marketing_shortlink_clicks.
  click_count       INTEGER NOT NULL DEFAULT 0,
  first_clicked_at  TIMESTAMPTZ,
  last_clicked_at   TIMESTAMPTZ,

  is_active         BOOLEAN NOT NULL DEFAULT true,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT marketing_shortlinks_workspace_slug_key
    UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS marketing_shortlinks_slug_idx
  ON public.marketing_shortlinks (slug);
CREATE INDEX IF NOT EXISTS marketing_shortlinks_campaign_idx
  ON public.marketing_shortlinks (campaign_id) WHERE campaign_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS public.marketing_shortlink_clicks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL,
  shortlink_id    UUID NOT NULL REFERENCES public.marketing_shortlinks(id) ON DELETE CASCADE,

  -- Resolved from cookie if the recipient came from a campaign and
  -- the pixel has been set on a prior page; null otherwise.
  recipient_id    UUID REFERENCES public.sms_campaign_recipients(id) ON DELETE SET NULL,

  user_agent      TEXT,
  ip_country      TEXT,
  referrer        TEXT,
  clicked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_shortlink_clicks_shortlink_idx
  ON public.marketing_shortlink_clicks (shortlink_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS marketing_shortlink_clicks_recipient_idx
  ON public.marketing_shortlink_clicks (recipient_id) WHERE recipient_id IS NOT NULL;


-- ── sms_campaigns extensions ─────────────────────────────────────
ALTER TABLE public.sms_campaigns
  -- One shared coupon code per campaign (e.g. MAYBLAST20). Generated
  -- at schedule time, embedded in the message via the {coupon}
  -- placeholder, disabled in Shopify after coupon_expires_days.
  ADD COLUMN IF NOT EXISTS coupon_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coupon_code TEXT,
  ADD COLUMN IF NOT EXISTS coupon_discount_pct INTEGER,
  ADD COLUMN IF NOT EXISTS coupon_expires_days_after_send INTEGER DEFAULT 21,
  -- Shopify's gid://shopify/DiscountCodeNode/... — used to disable
  -- via discountCodeUpdate (set endsAt) when expiry hits.
  ADD COLUMN IF NOT EXISTS coupon_shopify_node_id TEXT,
  ADD COLUMN IF NOT EXISTS coupon_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coupon_disabled_at TIMESTAMPTZ,

  -- Shortlink integration. shortlink_target_url is what the admin
  -- enters in the builder; shortlink_slug is what we generate at
  -- schedule time (after the marketing_shortlinks row exists).
  ADD COLUMN IF NOT EXISTS shortlink_target_url TEXT,
  ADD COLUMN IF NOT EXISTS shortlink_slug TEXT;


-- ── RLS ──────────────────────────────────────────────────────────
ALTER TABLE public.marketing_shortlinks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_shortlink_clicks  ENABLE ROW LEVEL SECURITY;

CREATE POLICY marketing_shortlinks_workspace_read ON public.marketing_shortlinks
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY marketing_shortlinks_service_all ON public.marketing_shortlinks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY marketing_shortlink_clicks_workspace_read ON public.marketing_shortlink_clicks
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY marketing_shortlink_clicks_service_all ON public.marketing_shortlink_clicks
  FOR ALL TO service_role USING (true) WITH CHECK (true);
