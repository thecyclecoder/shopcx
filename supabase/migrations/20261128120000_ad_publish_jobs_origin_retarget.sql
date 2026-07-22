-- ad_publish_jobs.origin — document the new 'media-buyer-retarget' value.
--
-- Introduced by v3 Ad Creative Engine goal M3 Phase 2
-- (docs/brain/specs/retarget-campaign-warm-hot-mixed-content.md). The column
-- itself is `text` (see 20260707120004_media_buyer_test_cohorts.sql: `add
-- column if not exists origin text;`), so a new value is a runtime string
-- constant — no schema change is required. This migration is a doc-only comment
-- update so `select column_comment` truthfully lists every origin the app writes
-- (grep target for anyone auditing the retarget rail):
--   NULL / 'operator' → studio / human publish route (unchanged).
--   'media-buyer-test' → Bianca's cold-test replenish rail
--     (bianca-route-ready-creatives-by-dahlia-temperature-tag).
--   'media-buyer-retarget' → the retarget replenish rail added by THIS spec.
--     Publishes warm+hot MIXED content into the retarget cohort's single
--     consolidated adset (media_buyer_retarget_cohorts.retarget_meta_adset_id);
--     evaluated by src/lib/media-buyer/retarget-publish-gate.ts
--     `evaluateMediaBuyerRetargetPublish` at the money step.

comment on column public.ad_publish_jobs.origin is
  $c$The CALLER of the publish job. NULL or 'operator' = the studio / human publish route (unchanged pre-media-buyer shape). 'media-buyer-test' = Bianca's cold-test replenish rail (bianca-route-ready-creatives-by-dahlia-temperature-tag; subject to media_buyer_test_cohorts gate). 'media-buyer-retarget' = the retarget replenish rail (retarget-campaign-warm-hot-mixed-content Phase 2; publishes warm+hot mixed content into media_buyer_retarget_cohorts.retarget_meta_adset_id; subject to the retarget publish gate at src/lib/media-buyer/retarget-publish-gate.ts).$c$;
