-- bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate Phase 2 —
-- CEO manual postability override. Sits ALONGSIDE `ad_campaigns.max_qc_eligible` (the
-- Max-computed postability flag added by Phase 2 of the prior spec). The override NEVER
-- overwrites Max's real grade (which lives on `ad_creative_copy_qc_verdicts`, per attempt);
-- it is a SEPARATE attributed action the CEO takes on the ad detail page when his review
-- disagrees with Max — the Max-vs-CEO gap IS the tuning signal the CEO uses in his live
-- Claude sessions to tune HOW Max grades.
--
-- Postability semantics after this migration:
--   `override_postable = TRUE`  → Bianca posts REGARDLESS of `max_qc_eligible` (CEO said so).
--   `override_postable = NULL`  → no override in play; fall back to `max_qc_eligible` (pre-Phase-2
--                                 behaviour byte-for-byte: TRUE / NULL post, FALSE holds).
-- (There is no `override_postable = FALSE`; a CEO who wants to un-post clears the whole
--  override — the spec calls the override reversible.)
--
-- Additive + idempotent. No default, no CHECK on `override_postable` (nullable boolean).
-- `override_score` is bounded 0..10 same as `persuasion_score` on the QC verdict row.

ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS override_postable BOOLEAN,
  ADD COLUMN IF NOT EXISTS override_score    INTEGER,
  ADD COLUMN IF NOT EXISTS override_reason   TEXT,
  ADD COLUMN IF NOT EXISTS override_by       UUID,
  ADD COLUMN IF NOT EXISTS override_at       TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ad_campaigns_override_score_range_chk'
  ) THEN
    ALTER TABLE public.ad_campaigns
      ADD CONSTRAINT ad_campaigns_override_score_range_chk
      CHECK (override_score IS NULL OR (override_score >= 0 AND override_score <= 10));
  END IF;
END $$;

COMMENT ON COLUMN public.ad_campaigns.override_postable IS
  'bianca-posts-only-at-9of10 Phase 2 — CEO manual postability override. TRUE = post regardless of max_qc_eligible (CEO overruled Max); NULL = no override, fall back to max_qc_eligible. Reversible — CEO clears by nulling this + override_score/reason/by/at. Never touches Max''s real grade on ad_creative_copy_qc_verdicts.';
COMMENT ON COLUMN public.ad_campaigns.override_score IS
  'bianca-posts-only-at-9of10 Phase 2 — CEO''s override score (usually MAX_QC_ELIGIBILITY_FLOOR, currently 9). Recorded next to Max''s real persuasion_score so the Max-vs-CEO gap is preserved as the tuning signal.';
COMMENT ON COLUMN public.ad_campaigns.override_reason IS
  'bianca-posts-only-at-9of10 Phase 2 — CEO''s written rationale for the override (required on set). Surfaced on the ad detail page next to Max''s real grade so the disagreement is auditable.';
COMMENT ON COLUMN public.ad_campaigns.override_by IS
  'bianca-posts-only-at-9of10 Phase 2 — auth.users id of the workspace owner/admin who set the override. Attribution; not a FK (auth schema is not FK''d from public per Supabase convention).';
COMMENT ON COLUMN public.ad_campaigns.override_at IS
  'bianca-posts-only-at-9of10 Phase 2 — timestamp when the override was set (or last updated). Cleared to NULL on override clear.';
