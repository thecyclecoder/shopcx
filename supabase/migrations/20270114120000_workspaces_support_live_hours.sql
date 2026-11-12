-- Software-mode live-hours handoff — per-workspace support "live hours".
--
-- Spec: software-mode-live-hours-handoff. In software mode (a self-serve SaaS tenant
-- workspace — anything that is NOT the managed Superfoods home workspace, where June /
-- the CS Director own escalations) the AI answers everything; the rare human handoff is
-- honest about WHEN a person will answer. `support_live_hours` describes the window a live
-- person is in chat:
--   { "tz": "America/New_York", "days": [1,2,3,4,5], "start": "09:00", "end": "17:00" }
--   tz    — IANA time zone the start/end are expressed in
--   days  — days of week the window is active (0=Sun … 6=Sat)
--   start/end — local "HH:MM" bounds of the window
--
-- NULL = never live → the escalation always shows the email-reply promise (the default, and
-- the seeded value for the ShopGrowth workspace until the CEO sets hours in widget settings).
-- Read by src/lib/support-mode.ts `getSupportLiveHours` / `isWithinLiveHours`.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS support_live_hours JSONB;
