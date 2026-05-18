-- profile_events.klaviyo_profile_id is no longer required. Our own SMS
-- send/click events don't have a Klaviyo profile id — they have a
-- customer_id (authoritative identity). Klaviyo-imported rows still
-- populate it. Companion migration 20260518182000 handles klaviyo_event_id.

ALTER TABLE profile_events
  ALTER COLUMN klaviyo_profile_id DROP NOT NULL;
