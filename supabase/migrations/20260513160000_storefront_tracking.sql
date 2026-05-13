-- ─────────────────────────────────────────────────────────────────
-- Storefront tracking + cart + event clearinghouse foundation.
--
-- Six tables that together power the post-Shopify storefront funnel:
--
--   storefront_sessions   one row per anonymous visitor, captures device +
--                         UTM + click IDs once per session (not per event).
--   storefront_events     append-only event log. Source of truth for the
--                         funnel; fan-out target for downstream CAPI sinks.
--                         PK is a client-generated UUID so browser + server
--                         CAPI events dedupe naturally.
--   storefront_leads      email/SMS capture submissions. Sourced from PDP
--                         popups / exit-intent / footer forms. Anonymous_id
--                         and (once matched) customer_id link back.
--   cart_drafts           server-side cart state. Token-bound (cookie),
--                         pricing validated server-side on every mutation.
--                         Abandoned carts fall out automatically (drafts
--                         with no associated order).
--   event_sinks           per-workspace downstream destinations
--                         (meta_capi, tiktok, google, klaviyo, custom).
--                         Holds encrypted creds + event type filters.
--   event_dispatches      per-event-per-sink delivery log. Drives the
--                         Inngest retry loop and gives observability into
--                         which events made it out, which are stuck.
--
-- See STOREFRONT.md for the architecture overview.
-- ─────────────────────────────────────────────────────────────────


-- ── storefront_sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.storefront_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- The cookie value. UUID v4 generated client-side on first PDP visit.
  -- Globally unique in practice (cookies are per-domain) but we constrain
  -- on (workspace_id, anonymous_id) for safety in multi-workspace browsing.
  anonymous_id     TEXT NOT NULL,

  -- Backfilled when the visitor identifies (lead capture, checkout, or
  -- login). Once set, all session + events rows with this anonymous_id
  -- get the same customer_id stitched in via a single UPDATE.
  customer_id      UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Device + browser fingerprint (parsed once at session creation, not
  -- per event). Aids segmentation queries without re-parsing UAs.
  user_agent       TEXT,
  device_type      TEXT,           -- 'mobile' | 'tablet' | 'desktop'
  os               TEXT,
  browser          TEXT,
  viewport_width   INTEGER,
  viewport_height  INTEGER,

  -- IP-derived geo from Vercel/CF request headers. We don't store raw IP
  -- to limit PII; country/region/city is enough for funnel segmentation.
  ip_country       TEXT,
  ip_region        TEXT,
  ip_city          TEXT,

  -- First-touch attribution. UTMs + ad-network click IDs are read from
  -- the landing URL on session creation and never overwritten — this is
  -- the source for "where did this customer come from."
  landing_url      TEXT,
  referrer         TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  utm_content      TEXT,
  utm_term         TEXT,
  fbclid           TEXT,           -- Meta click ID (from URL)
  gclid            TEXT,           -- Google click ID
  ttclid           TEXT,           -- TikTok click ID
  fbp              TEXT,           -- Meta _fbp browser cookie
  fbc              TEXT,           -- Meta _fbc click cookie

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT storefront_sessions_workspace_anonymous_key
    UNIQUE (workspace_id, anonymous_id)
);

CREATE INDEX IF NOT EXISTS storefront_sessions_customer_idx
  ON public.storefront_sessions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS storefront_sessions_workspace_created_idx
  ON public.storefront_sessions (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS storefront_sessions_anonymous_idx
  ON public.storefront_sessions (anonymous_id);


-- ── storefront_events ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.storefront_events (
  -- PK is the client-generated event UUID. Browser pixel and any
  -- server-side CAPI dispatch both reference this same ID so Meta /
  -- TikTok dedupe properly when dual-tracking is enabled.
  id               UUID PRIMARY KEY,

  workspace_id     UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_id       UUID NOT NULL REFERENCES public.storefront_sessions(id) ON DELETE CASCADE,

  -- Denormalized so funnel queries don't need to join through sessions.
  -- customer_id is backfilled when the session identifies; we batch-update
  -- both columns at once.
  anonymous_id     TEXT NOT NULL,
  customer_id      UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- Defined event types — keep this list in sync with STOREFRONT.md:
  --   pdp_view, pdp_engaged, pack_selected, customize_view,
  --   upsell_added, upsell_skipped, lead_captured, checkout_view,
  --   checkout_step_completed, order_placed, etc.
  event_type       TEXT NOT NULL,

  -- Optional product context (for product-scoped events like pdp_view).
  product_id       UUID REFERENCES public.products(id) ON DELETE SET NULL,

  -- Free-form per-event payload. Examples:
  --   pack_selected: { tier_qty, variant_id, mode, frequency_days }
  --   upsell_added:  { product_id, variant_id, qty }
  --   order_placed:  { order_id, total_cents, currency }
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Page where the event fired. Helps disambiguate same event type
  -- triggered from different surfaces (e.g. pack_selected from PDP vs.
  -- bundle table vs. customization page).
  url              TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storefront_events_workspace_created_idx
  ON public.storefront_events (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS storefront_events_session_created_idx
  ON public.storefront_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS storefront_events_anonymous_idx
  ON public.storefront_events (anonymous_id);
CREATE INDEX IF NOT EXISTS storefront_events_customer_idx
  ON public.storefront_events (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS storefront_events_type_created_idx
  ON public.storefront_events (event_type, created_at DESC);


-- ── storefront_leads ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.storefront_leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  email               TEXT,
  phone               TEXT,
  email_consent_at    TIMESTAMPTZ,
  sms_consent_at      TIMESTAMPTZ,

  -- Where the lead came in. Anonymous_id ties them to their PDP
  -- session even before customer match; session_id is the specific
  -- session at the moment of capture.
  anonymous_id        TEXT,
  session_id          UUID REFERENCES public.storefront_sessions(id) ON DELETE SET NULL,

  -- Backfilled when we match the lead to an existing customer (by
  -- email/phone) or auto-create a new customer record. Per design,
  -- leads become customers immediately — a customer with no orders
  -- IS naturally a lead, so we don't keep a parallel concept.
  customer_id         UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- Capture surface — 'pdp_popup', 'exit_intent', 'footer', etc.
  -- Drives the "which surface converts best" report.
  source              TEXT,
  coupon_code_issued  TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT storefront_leads_workspace_email_key
    UNIQUE (workspace_id, email)
);

CREATE INDEX IF NOT EXISTS storefront_leads_customer_idx
  ON public.storefront_leads (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS storefront_leads_anonymous_idx
  ON public.storefront_leads (anonymous_id);


-- ── cart_drafts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cart_drafts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Cookie-bound. Generated server-side on first /api/cart write,
  -- sent back as a Set-Cookie. Lets the cart survive across pages,
  -- devices (once identified), and 30+ days of inactivity.
  token                       TEXT NOT NULL UNIQUE,

  -- Visitor binding — same anonymous_id pattern as sessions/events.
  anonymous_id                TEXT,
  customer_id                 UUID REFERENCES public.customers(id) ON DELETE SET NULL,

  -- Line items. Each entry includes server-validated price snapshot
  -- so the cart remembers what the customer accepted at add-time, while
  -- pricing_rules can keep moving. Shape:
  --   [{ variant_id, product_id, quantity, selling_plan, price_cents,
  --      title, image_url, ... }]
  line_items                  JSONB NOT NULL DEFAULT '[]'::jsonb,

  discount_code               TEXT,
  subscription_frequency_days INTEGER,    -- when mode = subscribe

  shipping_address            JSONB,
  billing_address             JSONB,
  email                       TEXT,
  phone                       TEXT,

  -- Cached running totals — recomputed on every mutation.
  subtotal_cents              INTEGER NOT NULL DEFAULT 0,
  discount_cents              INTEGER NOT NULL DEFAULT 0,
  shipping_cents              INTEGER NOT NULL DEFAULT 0,
  tax_cents                   INTEGER NOT NULL DEFAULT 0,
  total_cents                 INTEGER NOT NULL DEFAULT 0,

  -- 'open' | 'converted' | 'abandoned'. Converted = customer paid;
  -- converted_order_id then points to the resulting order. Abandoned
  -- is set by a cron after expires_at passes with no conversion.
  status                      TEXT NOT NULL DEFAULT 'open',
  converted_order_id          UUID REFERENCES public.orders(id) ON DELETE SET NULL,

  -- Hard expiry — drafts older than this auto-abandon. Updated on
  -- every mutation so an active cart never expires from under the
  -- customer.
  expires_at                  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cart_drafts_anonymous_idx
  ON public.cart_drafts (anonymous_id) WHERE anonymous_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cart_drafts_customer_idx
  ON public.cart_drafts (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cart_drafts_status_updated_idx
  ON public.cart_drafts (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS cart_drafts_workspace_created_idx
  ON public.cart_drafts (workspace_id, created_at DESC);


-- ── event_sinks ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_sinks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- 'meta_capi' | 'tiktok_events' | 'google_enhanced' | 'klaviyo' | 'custom'
  sink_type    TEXT NOT NULL,
  name         TEXT NOT NULL,

  is_active    BOOLEAN NOT NULL DEFAULT true,

  -- Sink-specific credentials + tuning. Sensitive fields (access_token,
  -- api_key) are AES-256-GCM encrypted before storage, same pattern as
  -- the existing Shopify/Klaviyo creds.
  --   meta_capi:   { pixel_id, access_token_enc, test_event_code? }
  --   tiktok:      { pixel_id, access_token_enc }
  --   google:      { conversion_id, conversion_label, api_secret_enc }
  --   klaviyo:     { api_key_enc, list_id? }
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Empty array = forward all events. Otherwise = only forward these
  -- specific event_types (e.g. ['pack_selected', 'order_placed'] for a
  -- conversion-only Meta CAPI sink).
  event_types  TEXT[] NOT NULL DEFAULT '{}'::text[],

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT event_sinks_workspace_type_name_key
    UNIQUE (workspace_id, sink_type, name)
);

CREATE INDEX IF NOT EXISTS event_sinks_workspace_active_idx
  ON public.event_sinks (workspace_id, is_active);


-- ── event_dispatches ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_dispatches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  event_id           UUID NOT NULL REFERENCES public.storefront_events(id) ON DELETE CASCADE,
  sink_id            UUID NOT NULL REFERENCES public.event_sinks(id) ON DELETE CASCADE,

  -- 'pending' | 'sent' | 'failed' | 'dlq'
  --   pending → Inngest picks up
  --   sent    → 2xx response from downstream
  --   failed  → transient failure, will retry up to N times
  --   dlq     → exhausted retries, abandon
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_attempted_at  TIMESTAMPTZ,
  last_response_code INTEGER,
  last_response_body TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One dispatch row per (event, sink). If a dispatch fails and retries,
  -- we update this row's attempts + status, not create new rows.
  CONSTRAINT event_dispatches_event_sink_key UNIQUE (event_id, sink_id)
);

CREATE INDEX IF NOT EXISTS event_dispatches_status_idx
  ON public.event_dispatches (status, last_attempted_at);
CREATE INDEX IF NOT EXISTS event_dispatches_sink_status_idx
  ON public.event_dispatches (sink_id, status);


-- ── RLS — workspace-scoped read, service_role writes ─────────────
-- The /api/pixel endpoint, /api/cart, and Inngest workers all use the
-- admin client (service_role) for writes. Authenticated dashboard
-- users get SELECT scoped to their workspace via the standard pattern.

ALTER TABLE public.storefront_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_leads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_drafts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_sinks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_dispatches    ENABLE ROW LEVEL SECURITY;

CREATE POLICY storefront_sessions_workspace_read ON public.storefront_sessions
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY storefront_sessions_service_all ON public.storefront_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY storefront_events_workspace_read ON public.storefront_events
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY storefront_events_service_all ON public.storefront_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY storefront_leads_workspace_read ON public.storefront_leads
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY storefront_leads_service_all ON public.storefront_leads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY cart_drafts_workspace_read ON public.cart_drafts
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY cart_drafts_service_all ON public.cart_drafts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY event_sinks_workspace_read ON public.event_sinks
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY event_sinks_service_all ON public.event_sinks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY event_dispatches_workspace_read ON public.event_dispatches
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY event_dispatches_service_all ON public.event_dispatches
  FOR ALL TO service_role USING (true) WITH CHECK (true);
