-- Per-test-adset publish jobs have NO ad set until the publisher mints one (CEO Dylan, 2026-07-12).
--
-- The per-test path (20261018130000 / 20261019120000) enqueues an ad_publish_jobs row with
-- meta_adset_id = NULL and a create_adset_spec; adToolPublishToMeta creates the $150 ad set at publish
-- time and STAMPS meta_adset_id. But the base table declared meta_adset_id NOT NULL, so the enqueue
-- throws. Drop the NOT NULL and add a conditional CHECK: a job must carry EITHER an existing
-- meta_adset_id (legacy shared-adset publish) OR a create_adset_spec (the publisher mints one).
--
-- See docs/brain/tables/ad_publish_jobs.md · docs/brain/inngest/ad-tool.md.

alter table public.ad_publish_jobs
  alter column meta_adset_id drop not null;

alter table public.ad_publish_jobs
  drop constraint if exists ad_publish_jobs_adset_or_spec_chk;
alter table public.ad_publish_jobs
  add constraint ad_publish_jobs_adset_or_spec_chk
  check (meta_adset_id is not null or create_adset_spec is not null);

comment on column public.ad_publish_jobs.meta_adset_id is
  'The ad set the ad is created in. NULL only for per-test jobs carrying a create_adset_spec — the publisher mints the ad set and stamps this. Enforced by ad_publish_jobs_adset_or_spec_chk.';
