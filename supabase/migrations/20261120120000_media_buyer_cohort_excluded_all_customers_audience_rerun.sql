-- media_buyer_test_cohorts — bare Meta customaudience id for the ALL-CUSTOMERS
-- (full order history, hashed CUSTOMER_LIST) exclusion
-- (bianca-full-order-history-customer-list-exclusion-audience Phase 1).
--
-- Additive: adds a nullable text column that stores the BARE Meta
-- customaudience id (not our uuid) of the upload-based CUSTOMER_LIST audience
-- built from our entire order history across Shopify, Internal, and Amazon.
-- Complements the 180d pixel exclusion `excluded_purchaser_audience_id` from
-- the sibling spec — both ids compose into
-- targeting.excluded_custom_audiences on every per-test ad set. Phase 2
-- extends provision/replenish + the publish-gate; Phase 3 keeps the list
-- current via a weekly refresh cron. RLS unchanged (service-role full access
-- + workspace-member SELECT, inherited).
--
-- Fully idempotent (re-run = no-op).

alter table public.media_buyer_test_cohorts
  add column if not exists excluded_all_customers_audience_id text;
