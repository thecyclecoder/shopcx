-- Killer statics: per-ad landing routing.
--
-- Static ads need a per-ad destination so each archetype can route to its mapped
-- landing page (testimonial / authority / big_claim → PDP; advertorial →
-- advertorial lander; before_after → before/after lander). Until now the only
-- destination lived on ad_publish_jobs at publish time. landing_url is the
-- campaign's default destination; the PublishToMeta panel pre-fills from it and
-- the operator can override. See docs/brain/specs/killer-statics.md § Publish path.

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS landing_url text;

COMMENT ON COLUMN public.ad_campaigns.landing_url IS
  'Default click-through destination for this ad (pre-fills the Meta publish panel). Set from the archetype→lander map at seed time; operator-overridable.';
