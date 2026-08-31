-- Retire the Klaviyo tables that no longer have a reader (klaviyo-sunset, Phase B).
--
-- Reversible-by-default per docs/brain/operational-rules.md § Reversible-by-default
-- DB changes: rename to _deprecated_*_20260825 rather than DROP. These are NOT
-- empty — between them they hold ~220k rows — and `pg_stat_user_tables.n_live_tup`
-- reported several of them as 0 during the sunset audit, which is stale planner
-- stats, not truth. A bare DROP on the strength of that reading would have been
-- unrecoverable. The follow-up drop is a separate, deliberate decision once the
-- deprecation window has elapsed.
--
--   klaviyo_profile_directory    15,754 rows — last reader was klaviyo-engagement-sync (deleted)
--   klaviyo_profile_staging     161,620 rows — no reader in src/ at all
--   profile_engagement_summary   42,864 rows — last reader was klaviyo-engagement-backfill (deleted)
--
-- DELIBERATELY NOT TOUCHED — both still have live readers:
--   klaviyo_events (19,745)               → /api/workspaces/[id]/sms-campaigns/[campaignId]
--                                           dedups Klaviyo Placed Order events against `orders`
--                                           to catch conversions the Shopify webhook missed.
--                                           Frozen at 2026-05-14, so it only affects campaigns
--                                           older than that — but those numbers are real.
--   klaviyo_sms_campaign_history (55)     → /api/workspaces/[id]/klaviyo-sms-history, which backs
--                                           the marketing/text dashboard's campaign history table.
--   profile_events (4.66M)                → dual-sourced; our own SMS pipeline writes
--                                           Received SMS / Clicked SMS rows here. Never in scope.

ALTER TABLE IF EXISTS public.klaviyo_profile_directory  RENAME TO _deprecated_klaviyo_profile_directory_20260825;
ALTER TABLE IF EXISTS public.klaviyo_profile_staging    RENAME TO _deprecated_klaviyo_profile_staging_20260825;
ALTER TABLE IF EXISTS public.profile_engagement_summary RENAME TO _deprecated_profile_engagement_summary_20260825;

-- Both functions read tables that just moved, and both were only ever called by
-- Inngest functions deleted earlier in Phase B. Dropping a function is recoverable
-- from this migration's history; leaving one that references a renamed table is a
-- runtime error waiting for a caller that no longer exists.
-- Signatures confirmed against the live catalog before writing these.
DROP FUNCTION IF EXISTS public.rebuild_engagement_summary(p_workspace_id uuid);
DROP FUNCTION IF EXISTS public.recompute_klaviyo_attribution(p_workspace_id uuid, p_metric_id text);
