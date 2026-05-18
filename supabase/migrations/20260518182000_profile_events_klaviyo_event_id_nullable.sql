-- Companion to 20260518181000 — same reasoning, for klaviyo_event_id.
ALTER TABLE profile_events
  ALTER COLUMN klaviyo_event_id DROP NOT NULL;
