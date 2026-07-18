-- ad_creative_copy_qc_verdicts.per_format_creative + creative_gate_pass — Phase 1 of
-- max-qc-grades-the-creative-per-format-not-just-a-binary-render-ok. Max's binary render_ok
-- hard gate could not distinguish a mis-scaled product in the 1:1 crop from a fabricated
-- "FREE TOTE" badge in the feed 4:5 from a competitor offer leaked into the 9:16 pixels
-- while the 4:5 render happened to be clean. This migration adds the durable storage: two
-- additive columns on the existing ad_creative_copy_qc_verdicts row so the grade ledger
-- carries WHICH format failed WHICH check with a short finding, and a top-level roll-up
-- boolean the Phase-2 bounce dispatch reads to regenerate the offending format.
--
-- Shape pinned by src/lib/ads/creative-qa.ts:
--   per_format_creative: [
--     {
--       format: 'feed_4x5'|'stories_9x16'|'reels_9x16'|'right_column_1x1',
--       product_scale_ok: bool,
--       no_hallucinated_offer_or_badge: bool,
--       no_in_pixel_competitor_leak: bool,
--       on_image_text_legible: bool,
--       findings: string[]
--     },
--     ...
--   ] | null
--   creative_gate_pass: bool -- top-level roll-up; true iff every per-format entry has
--                               all four checks true (or the block is null — legacy absent
--                               case, no gate to enforce).
--
-- HARD-GATE driver in Phase 2 (the bounce dispatch reads creative_gate_pass to regenerate
-- the offending format). Phase 1 lands the storage + parser + SKILL only; the wiring is
-- separate. Nullable + no default (per_format_creative) / non-null with default true
-- (creative_gate_pass — a legacy row without the block is trivially "no creative signal
-- to fail", so true is the safe default). Legacy rows survive unchanged.
--
-- Additive + idempotent (add column IF NOT EXISTS). Safe to re-apply.
-- Applied by the Control Tower migration-drift reconciler's applyMergedMigrations path
-- once this PR merges to main (classifyMigrationSql → additive → auto-apply). No bespoke
-- pre-merge apply is required.
alter table public.ad_creative_copy_qc_verdicts
  add column if not exists per_format_creative jsonb;

alter table public.ad_creative_copy_qc_verdicts
  add column if not exists creative_gate_pass boolean not null default true;

comment on column public.ad_creative_copy_qc_verdicts.per_format_creative is
  'Per-format Max creative-QC findings (max-qc-grades-the-creative-per-format-not-just-a-binary-render-ok Phase 1). JSON array of { format, product_scale_ok, no_hallucinated_offer_or_badge, no_in_pixel_competitor_leak, on_image_text_legible, findings[] }; NULL on a legacy single-image verdict (no creative signal to record). The Phase-2 bounce dispatch reads this column to regenerate the offending format.';

comment on column public.ad_creative_copy_qc_verdicts.creative_gate_pass is
  'Top-level hard creative gate (max-qc-grades-the-creative-per-format-not-just-a-binary-render-ok Phase 1). TRUE iff every per_format_creative entry has all four checks true, or per_format_creative is NULL. FALSE when any format entry has any check FALSE. Default TRUE so legacy rows (predate this migration) do not appear as false-fails on the read side. The Phase-2 bounce dispatch reads this to trigger a per-format regenerate.';
