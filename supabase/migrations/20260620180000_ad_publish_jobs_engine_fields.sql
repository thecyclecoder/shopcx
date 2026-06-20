-- Storefront Iteration Engine — Phase 6b: let an engine-created publish job carry
-- an explicit ad name (for the engine-created marker) and link back to the
-- iteration_recommendation it executes (for write-back + idempotency).
--
-- `ad_name`           — when set, ad-tool/publish-to-meta uses it as the ad/creative
--                       name instead of the source ad_campaigns.name, so engine
--                       drafts can carry the stable `[ie]` marker without renaming
--                       the operator's campaign.
-- `recommendation_id` — the iteration_recommendations row this job fulfills; on a
--                       successful publish the publisher writes the meta ids back to
--                       that row (status='executed'), or status='failed' on error.
-- See docs/brain/specs/storefront-iteration-engine.md (Phase 6b).

ALTER TABLE public.ad_publish_jobs
  ADD COLUMN IF NOT EXISTS ad_name TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_id UUID
    REFERENCES public.iteration_recommendations(id) ON DELETE SET NULL;

-- Look up the publish job that fulfills a given recommendation (idempotency guard).
CREATE INDEX IF NOT EXISTS ad_publish_jobs_recommendation_idx
  ON public.ad_publish_jobs (recommendation_id)
  WHERE recommendation_id IS NOT NULL;
