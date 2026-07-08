-- media-buyer-test-winner-loop Phase 2 — add default publish targets to media_buyer_test_cohorts.
--
-- Phase 1 designated the test AD SET (and its daily ceiling). To let the Media
-- Buyer runner (Phase 2) actually insert ad_publish_jobs rows for the replenish
-- action, the cohort ALSO needs the ad account + page + IG user id the publisher
-- ships each replenish job under. All three are NULLABLE — an existing Phase 1
-- cohort row keeps working (the runner's replenish just skips + records a
-- 'media_buyer_replenish_missing_config' director_activity row until the row
-- is completed by the workspace owner).

alter table public.media_buyer_test_cohorts
  add column if not exists default_meta_account_id text,
  add column if not exists default_meta_page_id text,
  add column if not exists default_meta_instagram_user_id text;
