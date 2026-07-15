-- Drop the never-run 48h "be Max for 48h" watch scaffolding (CEO 2026-07-10 → dropped 2026-07-13).
-- The table was created but never wired to any executor: no cron / inngest fn / box lane ever
-- enqueued a max_watch turn, and no src/ code references max_watch_windows. The /director-training
-- skill (which read this table) is being deleted in the same PR. god-mode — the separate live
-- feature the watch would have driven — is unaffected. See docs/brain/libraries/budget-alerts.
drop table if exists public.max_watch_windows cascade;  -- reversible: never-wired scaffolding — no cron / inngest fn / box lane ever enqueued a max_watch turn, no src/ code references max_watch_windows, and the only reader (/director-training skill) is deleted in the same PR; god-mode (the separate live feature) is unaffected.
