-- mb-digest-workspace-toggle: a per-workspace off switch for the media-buyer (Bianca) Slack digest
-- that Max posts to #director-growth-max after every media-buyer pass (every ~2h via the intraday
-- media-buyer-test-cadence cron). Default TRUE preserves existing behavior for every other tenant;
-- the founder set it FALSE for Superfoods to silence the 2-hourly digest without touching the
-- underlying media-buyer pass, the meta_insights sync, or any other Max Slack post.
-- Gated in src/lib/media-buyer/director-digest.ts `deliverMediaBuyerDigest`.
alter table public.workspaces
  add column if not exists media_buyer_digest_enabled boolean not null default true;

comment on column public.workspaces.media_buyer_digest_enabled is
  'When false, suppresses the media-buyer (Bianca) Slack digest Max posts to #director-growth-max '
  'after each media-buyer pass (deliverMediaBuyerDigest early-returns). Does NOT affect the media-buyer '
  'pass, meta_insights sync, or other Max posts. Default true. (mb-digest-workspace-toggle)';
