-- ─────────────────────────────────────────────────────────────────
-- Definitive Klaviyo campaign attribution via landing-site UTMs.
--
-- Every Klaviyo SMS send tags the link with utm_source=Klaviyo,
-- utm_medium=sms, and crucially utm_id=<klaviyo_campaign_id>. The
-- value surfaces on Shopify Placed Order events under
-- event_properties.$extra.landing_site. By denormalizing the UTM
-- fields onto klaviyo_events at import time, attribution becomes a
-- precise JOIN on campaign_id instead of a 7-day post-send window
-- heuristic.
--
-- Use cases this unlocks:
--   - Exact "who bought from this campaign" list (no more 68 vs 12
--     mystery)
--   - Per-profile pre-purchase event histories filtered to actual
--     campaign buyers — the AI segment builder's training input
--   - Multi-touch view: if a buyer clicked SMS then clicked email
--     before purchasing, we see the LAST attribution
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.klaviyo_events
  ADD COLUMN IF NOT EXISTS attributed_klaviyo_campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_source TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_medium TEXT,
  ADD COLUMN IF NOT EXISTS attributed_utm_campaign TEXT;

-- Hot index — every attribution recompute is a scan by campaign.
-- Partial so it stays small (most events have no attribution).
CREATE INDEX IF NOT EXISTS klaviyo_events_attributed_campaign_idx
  ON public.klaviyo_events (workspace_id, attributed_klaviyo_campaign_id)
  WHERE attributed_klaviyo_campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS klaviyo_events_attributed_utm_source_idx
  ON public.klaviyo_events (workspace_id, attributed_utm_source, attributed_utm_medium)
  WHERE attributed_utm_source IS NOT NULL;
