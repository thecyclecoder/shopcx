-- Rename klaviyo_profile_events → profile_events. We are sunsetting
-- Klaviyo as a data source — events now come from our own SMS pipeline
-- and storefront pixel. The Klaviyo-imported rows that already exist
-- stay in place and remain queryable under the new neutral name.
--
-- Also rename the related campaign attribution column:
--   attributed_klaviyo_campaign_id → attributed_campaign_id
-- (it holds the UUID of whichever campaign drove the event — Klaviyo
-- campaign id for legacy rows, our sms_campaigns.id for new ones.)
--
-- klaviyo_event_id and klaviyo_profile_id are LEFT as-is. They reference
-- foreign-system identifiers on the original-source rows, and renaming
-- them would imply they apply to non-Klaviyo events (they don't).

ALTER TABLE IF EXISTS klaviyo_profile_events RENAME TO profile_events;

ALTER TABLE profile_events
  RENAME COLUMN attributed_klaviyo_campaign_id TO attributed_campaign_id;

-- Reapply / rename indexes that referenced the old table name so they
-- stay self-documenting. Postgres keeps the underlying index when a
-- table is renamed, but the index NAME doesn't update — fix that.
ALTER INDEX IF EXISTS klaviyo_profile_events_pkey
  RENAME TO profile_events_pkey;
ALTER INDEX IF EXISTS klaviyo_profile_events_workspace_customer_idx
  RENAME TO profile_events_workspace_customer_idx;
ALTER INDEX IF EXISTS klaviyo_profile_events_workspace_metric_idx
  RENAME TO profile_events_workspace_metric_idx;
ALTER INDEX IF EXISTS klaviyo_profile_events_workspace_datetime_idx
  RENAME TO profile_events_workspace_datetime_idx;
ALTER INDEX IF EXISTS klaviyo_profile_events_klaviyo_event_id_idx
  RENAME TO profile_events_klaviyo_event_id_idx;
ALTER INDEX IF EXISTS klaviyo_profile_events_attributed_campaign_idx
  RENAME TO profile_events_attributed_campaign_idx;
