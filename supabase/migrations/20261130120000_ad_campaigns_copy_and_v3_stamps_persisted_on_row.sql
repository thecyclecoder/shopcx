-- held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 —
-- make the ad_campaigns row self-describing so a HELD (max_qc_eligible=false) draft still
-- renders its authored caption on the ad detail page even when the sibling product_ad_angles
-- insert missed (the 2026-07-22 Ashwavana 102a218f case: strong caption + hold_flag persisted,
-- but angle_id was null so the copy could not be read back through the angle join).
--
-- Four new columns, all NULLABLE (existing rows keep working; the detail page falls back
-- through angle → campaign → nothing without a schema shim):
--   • headline       — the authored headline string (== copy_pack.headlines[0])
--   • primary_text   — the authored primary text (== copy_pack.primaryTexts[0])
--   • description    — the authored description
--   • metadata       — jsonb envelope; today carries { copy_pack: MetaCopyPack }
--
-- The v3 attribution stamps (creative_theme / angle_palette_id / headline_pattern_id /
-- creative_combination_id) were added by the earlier v3 M1 migration
-- (20261123120000_v3_creative_engine_angle_palette_pattern_library.sql) but never written by
-- the eligible or held paths. This migration is the SCHEMA companion for both the copy
-- persist and the stamp write — buildAdCampaignInsertBody in src/lib/ads/creative-agent.ts
-- is updated in the same PR to actually write these columns on every insert.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS + no backfill + no default. Pre-Phase rows land
-- NULL on all four fields, which the ad detail page + Bianca's postability filter tolerate.

alter table public.ad_campaigns
  add column if not exists headline     text,
  add column if not exists primary_text text,
  add column if not exists description  text,
  add column if not exists metadata     jsonb;

comment on column public.ad_campaigns.headline is
  'held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — authored headline string persisted DIRECTLY on the campaign row so a HELD draft is inspectable + re-renderable even if the sibling product_ad_angles insert missed. Equals copy_pack.headlines[0] on inserts written by buildAdCampaignInsertBody. NULL on pre-Phase rows and deterministic-mode inserts that never supplied a MetaCopyPack.';
comment on column public.ad_campaigns.primary_text is
  'held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — authored primary text persisted directly on the campaign row (== copy_pack.primaryTexts[0]). NULL on pre-Phase rows / deterministic-mode inserts.';
comment on column public.ad_campaigns.description is
  'held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — authored description string persisted directly on the campaign row (== copy_pack.description). NULL on pre-Phase rows / deterministic-mode inserts.';
comment on column public.ad_campaigns.metadata is
  'held-creatives-persist-authored-copy-and-v3-stamps-to-the-draft Phase 1 — jsonb envelope carrying the full MetaCopyPack under `copy_pack` so the detail page renders the framework-labelled variations without needing the angle_id join. Shape: `{ copy_pack: { headlines: string[], primaryTexts: string[], description: string, frameworks?: string[] } }`. NULL on pre-Phase rows.';
