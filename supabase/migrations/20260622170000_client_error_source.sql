-- Client-Side Error Capture — Phase 1 (see docs/brain/specs/client-error-capture.md).
--
-- The MISSING FOURTH error feed: client-side JS that breaks the UX in the
-- user's browser — a React render crash on the PDP, a broken "customize"
-- interaction, an unhandled promise rejection / Braintree failure on checkout,
-- a thank-you script error, a portal crash. Our Vercel log drain only sees
-- SERVER-side errors; browser crashes are invisible to it.
--
-- The storefront + portal reporters POST these to the public /api/client-errors
-- ingest, which records them into the SAME grouped error_events store as the
-- inngest / vercel / supabase feeds under a NEW source 'client' — so the Control
-- Tower shows them as their own "Client errors" panel.
--
-- One change: widen the error_events.source CHECK to admit 'client'.

alter table public.error_events drop constraint if exists error_events_source_check;
alter table public.error_events
  add constraint error_events_source_check
  check (source in ('inngest', 'vercel', 'supabase', 'supabase-logs', 'client'));
