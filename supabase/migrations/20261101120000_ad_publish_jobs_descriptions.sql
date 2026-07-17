-- ad_publish_jobs.descriptions — Phase 1 of dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection.
-- Sibling to headlines / primary_texts (both jsonb text-array): carries N descriptions so the publisher
-- (src/lib/inngest/ad-tool.ts) can build Meta's asset_feed_spec descriptions[] with 1 entry per
-- temperature-banded variant read from ad_creative_copy_variants. Legacy single-string description column
-- is retained (used by link_data image ads + as the single-element fallback when descriptions is null),
-- so a deterministic-mode / studio publish that only sets `description` stays byte-identical to today.
--
-- Additive + idempotent. No CHECK on jsonb shape — the .ts writer (resolveReplenishAdCopy) pins the
-- string-array contract; a jsonb CHECK would fight legacy studio callers that never set the column.
alter table public.ad_publish_jobs
  add column if not exists descriptions jsonb;

comment on column public.ad_publish_jobs.descriptions is
  'Multi-variant Meta link descriptions (dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection Phase 1). Populated from ad_creative_copy_variants when the temperature-banded pack exists; null on legacy studio / deterministic-mode jobs (publisher falls back to [description] single-element). Consumed by adToolPublishToMeta to build asset_feed_spec.descriptions[] 1:1.';
