-- Drop the unused composite index on klaviyo_profile_events. The DB Health Agent's
-- index pass flagged it (signature dbhealth:unused-index:klaviyo_profile_events_profile_metric_dt):
-- pg_stat_user_indexes shows idx_scan == 0 while the table takes ongoing INSERT traffic from
-- the Klaviyo events import (docs/brain/inngest/klaviyo-events-import.md), so every write pays
-- the maintenance cost for a read pattern nothing exercises. The unique
-- (workspace_id, klaviyo_event_id) index still backs upsert dedup, and
-- klaviyo_profile_events_metric_dt covers the workspace × metric × time scan.
--
-- Applied to PROD with `DROP INDEX CONCURRENTLY` (can't run inside a migration transaction);
-- see scripts/apply-drop-klaviyo-profile-events-profile-metric-dt-index.ts. Recorded here as
-- plain IF EXISTS (no CONCURRENTLY) so fresh/local environments that just replayed the
-- creating migration (20260514190000_profile_engagement.sql) don't carry it forward.

DROP INDEX IF EXISTS public.klaviyo_profile_events_profile_metric_dt;
