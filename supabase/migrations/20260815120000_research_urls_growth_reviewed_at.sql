-- rhea-research-automation spec, Phase 3 — Cleo handoff watermark.
--
-- Adds `growth_reviewed_at timestamptz null` to public.research_urls — the watermark Cleo (Growth)
-- stamps via listNewTeardowns / markTeardownReviewed once she's read the row's teardown recipe.
-- New teardowns surface to Cleo where `teardown IS NOT NULL AND growth_reviewed_at IS NULL`; the
-- stamp drops them out of the discovery reader. This is the DISCOVERY surface only — slice 4
-- adds the actual gap-analysis loop that consumes it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.

alter table public.research_urls
  add column if not exists growth_reviewed_at timestamptz null;

-- Partial index that matches the listNewTeardowns query shape:
--   WHERE workspace_id = ? AND teardown IS NOT NULL AND growth_reviewed_at IS NULL
--   ORDER BY ad_count DESC
-- Small (only unreviewed-worthy rows) + drops out of the index the moment the watermark stamps.
create index if not exists research_urls_growth_unreviewed_idx
  on public.research_urls (workspace_id, ad_count desc)
  where teardown is not null and growth_reviewed_at is null;
