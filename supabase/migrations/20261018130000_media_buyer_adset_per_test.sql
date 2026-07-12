-- Per-test-adset model for the media-buyer test loop (CEO Dylan, 2026-07-12).
--
-- The researched best practice (deep-research 2026-07-12) is ABO with ONE creative per dedicated-budget
-- ad set, each at the full ~$150/day so the whole budget tests that one creative — 4 concurrent = the
-- $600/day ceiling. Today Bianca's replenish publishes N ads into ONE shared cohort adset
-- (media_buyer_test_cohorts.test_meta_adset_id), which commingles budgets. This migration adds the model
-- for "a fresh $150 adset per test creative," gated OFF by default so the live Tabs/Coffee loop is
-- untouched until a cohort opts in.
--
--   • adset_per_test            — mode flag. false (default) = legacy single shared adset (unchanged).
--                                 true = the loop creates a fresh adset per test creative in the cohort's
--                                 testing campaign, each at per_test_daily_budget_cents.
--   • test_meta_campaign_id     — the ABO testing campaign new per-test adsets are created under
--                                 (getOrCreateTestingCampaign). Legacy cohorts leave it null.
--   • per_test_daily_budget_cents — the fixed $150/day each test adset carries. daily_test_ceiling_cents
--                                 ÷ this = max concurrent tests (4 at $600/$150). Default 15000.
--   • adset_template            — the cloned adset spec (optimization/billing/bid/pixel/targeting) so every
--                                 test adset isolates ONLY the creative (same audience across the cohort).
--   • ad_publish_jobs.create_adset_spec — when set, the publisher creates the adset from this spec BEFORE
--                                 the ad (the per-test path); null = publish into the row's meta_adset_id.
--
-- See docs/brain/libraries/provision-cohort.md · docs/brain/tables/media_buyer_test_cohorts.md.

alter table public.media_buyer_test_cohorts
  add column if not exists adset_per_test boolean not null default false,
  add column if not exists test_meta_campaign_id text,
  add column if not exists per_test_daily_budget_cents integer not null default 15000,
  add column if not exists adset_template jsonb;

comment on column public.media_buyer_test_cohorts.adset_per_test is
  'Mode: false (default) = legacy single shared test adset; true = create a fresh $150 adset per test creative in test_meta_campaign_id. CEO 2026-07-12.';
comment on column public.media_buyer_test_cohorts.per_test_daily_budget_cents is
  'Fixed daily budget each per-test adset carries (default 15000 = $150). daily_test_ceiling_cents ÷ this = max concurrent tests.';
comment on column public.media_buyer_test_cohorts.adset_template is
  'Cloned adset spec (optimization_goal, billing_event, bid_strategy, pixel_id, custom_event_type, targeting) applied to every per-test adset so only the CREATIVE varies across the cohort.';

alter table public.ad_publish_jobs
  add column if not exists create_adset_spec jsonb;

comment on column public.ad_publish_jobs.create_adset_spec is
  'Per-test-adset path: when set, adToolPublishToMeta creates the adset from this spec (createAdSet) BEFORE the ad and stamps meta_adset_id. Null = publish into the row''s existing meta_adset_id (legacy shared adset).';
