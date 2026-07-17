-- ad_creative_copy_qc_verdicts.scroll_stop — advisory scroll-stop sub-scores for Max's copy-QC
-- verdict (docs/brain/specs/max-copy-qc-scroll-stop-dims Phase 1). The M1 keystone
-- (dahlia-max-independent-copy-qc-box-session) shipped a rolled-up 0-10 persuasion_score, but a
-- single number cannot be correlated against a SPECIFIC scroll-stop failure mode. This column
-- stores three named 0-2 sub-scores + an evidence[] array so future CAC correlation has a
-- granular signal to move against.
--
-- Shape (jsonb, pinned by the .ts parser in src/lib/ads/creative-qa.ts):
--   { headline_readable_in_3_frames: 0|1|2,
--     visual_hierarchy_supports_headline: 0|1|2,
--     first_line_earns_the_second: 0|1|2,
--     evidence: string[] }
--
-- ADVISORY only — the M1 no-Goodhart contract still holds. A low sub-score NEVER blocks the bin
-- insert; hard gates live in `hard_gates`. Nullable + no default so pre-Phase-1 rows survive
-- unchanged; new writes always carry a populated object (the .ts parser refuses fail-closed on a
-- missing / null scroll_stop).
alter table public.ad_creative_copy_qc_verdicts
  add column if not exists scroll_stop jsonb;

comment on column public.ad_creative_copy_qc_verdicts.scroll_stop is
  'Advisory scroll-stop sub-scores from Max copy-QC — { headline_readable_in_3_frames:0..2, visual_hierarchy_supports_headline:0..2, first_line_earns_the_second:0..2, evidence:string[] }. Advisory only; never a hard-gate driver. Nullable for pre-Phase-1 rows; new writes always populate it (max-copy-qc-scroll-stop-dims Phase 1).';
