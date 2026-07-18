-- max-qc-always-bins-ad-7of10-gates-only-bianca-postability Phase 2 — the eligibility flag
-- Bianca's ready-to-test read filters on. TRUE = Max's copy-QC gate passed (hard_gate_pass +
-- persuasion_score >= MAX_QC_ELIGIBILITY_FLOOR), the creative is POSTABLE. FALSE = Max was in
-- play but the verdict fell below the floor (or hard-gate failed / dispatch errored), the
-- creative is BINNED-BUT-INELIGIBLE (saved + visible on the detail page with Max's critiques,
-- excluded from Bianca's postable list). NULL = Max never ran on this creative — the
-- kill-switch was off, the deterministic buildMetaCopyPack path minted it, or the row predates
-- Max's gate; Bianca's filter preserves today's byte-identical behavior for these rows.
--
-- Additive column, no default, no CHECK — the readers (`listReadyToTest`) narrow with
-- `.not("max_qc_eligible", "is", false)` so a NULL row is included alongside a TRUE row. The
-- writer chokepoint is `buildAdCampaignInsertBody` in src/lib/ads/creative-agent.ts —
-- deterministic-mode inserts pass no maxQcEligible arg (stays NULL); the Max-scored path passes
-- the pure `isCopyQcEligible(verdict)` result. See docs/brain/tables/ad_campaigns.md +
-- docs/brain/libraries/creative-agent.md for the lifecycle. Auto-applied on merge to main by
-- the Control Tower migration-drift reconciler.

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS max_qc_eligible BOOLEAN;

COMMENT ON COLUMN public.ad_campaigns.max_qc_eligible IS
  'max-qc-always-bins-ad-7of10-gates-only-bianca-postability Phase 2 — Max copy-QC eligibility flag: TRUE = postable (in Bianca''s ready-to-test), FALSE = binned-but-ineligible (visible on detail page but excluded from Bianca''s postable list), NULL = Max never ran (legacy / deterministic-mode / kill-switch off). Bianca reads with .not(is,false) so NULL rows behave byte-identically to pre-Phase-2 today.';
