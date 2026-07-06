-- portal-order-detail-tracking-widget — Phase 1.
-- (docs/brain/specs/portal-order-detail-tracking-widget.md, Phase 1)
--
-- Add a nullable jsonb column to cache the EasyPost Tracker milestone
-- events blob per order. The existing `easypost_detail` text column stays
-- as-is (short human-readable line); this column stores the structured
-- events array so the portal order-detail page can render a milestone
-- timeline without re-hitting EasyPost on every visit.
--
--   easypost_tracking — jsonb: { events: [{ status, message, datetime,
--                       tracking_location: { city, state, country } }] }
--                       (subset of the EasyPost Tracker payload we render).

alter table public.orders
  add column if not exists easypost_tracking jsonb;
