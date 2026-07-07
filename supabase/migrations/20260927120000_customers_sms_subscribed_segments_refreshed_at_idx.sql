-- The Control Tower monitor's SMS-subscribed stale-tail head-count 500s once a
-- day at Supabase-logs signature `b9905c8e7f3f9e56`. The query filters ~138K
-- rows where sms_marketing_status='subscribed' with an OR predicate on
-- segments_refreshed_at (IS NULL OR older than 48h) and asks for an exact
-- count (`count: "exact", head: true`). No index covered segments_refreshed_at
-- on that slice, so Postgres seq-scanned the subscribed rows and touched every
-- heap tuple to resolve the OR — under concurrent load it exceeded the
-- statement timeout and PostgREST 500'd the HEAD /rest/v1/customers request.
--
-- Partial btree on segments_refreshed_at WHERE sms_marketing_status =
-- 'subscribed' is the exact shape of the monitor's slice. Postgres can then
-- BitmapOr an Index Scan for `IS NULL` with an Index Range Scan for `< cutoff`
-- and answer the count without visiting heap. Additive to the existing
-- `customers_sms_audience_idx (workspace_id, sms_marketing_status) WHERE phone
-- IS NOT NULL` — that one is keyed by workspace_id for the campaign audience
-- resolve, and does not carry segments_refreshed_at.
--
-- Applied to PROD via `scripts/apply-customers-sms-segments-refreshed-partial-index.ts`
-- (CREATE INDEX CONCURRENTLY, which cannot run inside a migration transaction).
-- Recorded here as IF NOT EXISTS (no CONCURRENTLY) so fresh/local environments
-- build it and the repo schema stays accurate — same convention as
-- 20260817120000_tickets_escalated_at_partial_index.sql.

CREATE INDEX IF NOT EXISTS idx_customers_sms_subscribed_segments_refreshed_at
  ON public.customers (segments_refreshed_at)
  WHERE sms_marketing_status = 'subscribed';
