-- Add campaign attribution to klaviyo_profile_events.
--
-- The Received SMS backfill originally followed the engagement-backfill
-- schema (light, no event_properties) — that was fine for click/open
-- metrics where we just need to count occurrences. But for Received SMS
-- specifically, the whole point of pulling it is recipient-list
-- reconstruction per campaign, which requires knowing which campaign
-- each receipt belongs to.
--
-- Klaviyo encodes this in event_properties.$message (their naming is
-- confusing — it's actually the campaign_id, not the message_id). We
-- extract that to a dedicated column rather than storing the whole
-- properties blob — keeps the table lean while preserving the only
-- field we actually need for downstream analysis.

ALTER TABLE klaviyo_profile_events
  ADD COLUMN IF NOT EXISTS attributed_klaviyo_campaign_id TEXT;

-- Index for the recipient-set lookup: "all profiles who received campaign X"
CREATE INDEX IF NOT EXISTS klaviyo_profile_events_campaign_idx
  ON klaviyo_profile_events (workspace_id, attributed_klaviyo_campaign_id)
  WHERE attributed_klaviyo_campaign_id IS NOT NULL;
