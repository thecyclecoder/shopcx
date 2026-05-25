-- Audience-resolve during SMS campaign scheduling was doing full
-- sequential scans of customers (138K rows) on every .range() page.
-- With concurrency: 4 on textCampaignScheduled, that meant ~100
-- concurrent seq scans of the customers table, saturating the
-- Supavisor pool and producing 504s on unrelated routes (e.g. the
-- shortlink redirect). Pair this with concurrency=1 on the schedule
-- function and keyset pagination on resolve-audience.

-- Partial index on the SMS-eligibility filter — covers the WHERE
-- "phone IS NOT NULL AND sms_marketing_status='subscribed'" predicate
-- that every campaign's audience query uses. Partial keeps it small.
CREATE INDEX IF NOT EXISTS customers_sms_audience_idx
  ON public.customers (workspace_id, sms_marketing_status)
  WHERE phone IS NOT NULL;

-- GIN index on segments so `segments && '{archetype}'` (PostgREST's
-- .overlaps()) uses an index instead of seq-scanning + per-row array
-- comparison. Each segmented send right now scans 138K rows otherwise.
CREATE INDEX IF NOT EXISTS customers_segments_gin
  ON public.customers USING GIN (segments);
