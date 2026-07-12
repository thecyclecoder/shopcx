-- Per-test-adset cohorts have NO single shared test ad set (CEO Dylan, 2026-07-12).
--
-- The per-test model (20261018130000_media_buyer_adset_per_test.sql) mints a fresh $150 ad set per test
-- creative in test_meta_campaign_id — there is no one `test_meta_adset_id` to point at. But the base table
-- (20260707120000) declared `test_meta_adset_id text not null`, so provisionProductTestCohort (which inserts
-- a per-test row WITHOUT that column) would throw a NOT NULL violation. Drop the blanket NOT NULL and
-- replace it with a conditional CHECK: legacy (shared-adset) cohorts still REQUIRE test_meta_adset_id;
-- per-test cohorts may leave it null (the adset is minted at publish time).
--
-- See docs/brain/libraries/provision-cohort.md · docs/brain/tables/media_buyer_test_cohorts.md.

alter table public.media_buyer_test_cohorts
  alter column test_meta_adset_id drop not null;

-- A shared-adset cohort MUST still name its adset; a per-test cohort may not.
alter table public.media_buyer_test_cohorts
  drop constraint if exists media_buyer_test_cohorts_adset_shape_chk;
alter table public.media_buyer_test_cohorts
  add constraint media_buyer_test_cohorts_adset_shape_chk
  check (adset_per_test = true or test_meta_adset_id is not null);

comment on column public.media_buyer_test_cohorts.test_meta_adset_id is
  'The single shared test ad set (legacy adset_per_test=false model). NULL for per-test cohorts, which mint a fresh $150 ad set per creative in test_meta_campaign_id. Enforced by media_buyer_test_cohorts_adset_shape_chk.';
