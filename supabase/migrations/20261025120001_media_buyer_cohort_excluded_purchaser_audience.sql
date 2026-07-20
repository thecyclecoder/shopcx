-- media_buyer_test_cohorts — bare Meta customaudience id for the last-180d
-- purchasers exclusion (bianca-cold-test-recent-purchaser-exclusion Phase 1).
--
-- Additive: adds a nullable text column that stores the BARE Meta
-- customaudience id (not our uuid) of the website custom audience the cohort
-- must exclude on every per-test ad set. Provision (Phase 2) stamps it during
-- cohort creation; the publish-gate (Phase 3) refuses a publish whose
-- targeting.excluded_custom_audiences does not carry this id. RLS unchanged
-- (service-role full access + workspace-member SELECT, inherited).
--
-- Fully idempotent (re-run = no-op).

alter table public.media_buyer_test_cohorts
  add column if not exists excluded_purchaser_audience_id text;
