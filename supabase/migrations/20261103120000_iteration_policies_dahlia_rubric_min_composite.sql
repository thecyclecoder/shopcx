-- iteration_policies.dahlia_rubric_min_composite — the per-workspace THRESHOLD Max's
-- Phase-2 5-axis rubric composite (0..10) must clear before a Dahlia creative flips to
-- `ad_campaigns.status='ready'` in Bianca's ready-to-test bin
-- (docs/brain/specs/dahlia-researches-from-winners-flow-ad-library.md Phase 3).
--
-- Grounded in the spec's "ready-to-bin quality gate" rule: reject-only at 7/10 with a
-- grader that starts at 5-6 would leave the bin EMPTY. Revise-to-pass fills the bin with
-- genuinely good creative; a tunable threshold lets the bar rise as quality climbs. The
-- setpoint lives here, on the SAME iteration_policies row Bianca reads for her trim/scale
-- thresholds — one control surface for growth's tuneable knobs, one composer per workspace.
--
-- Default 7 — the spec's opening bar ("default 7/10 composite"). Ratchets up over time as
-- Dahlia's grader baseline improves; a workspace whose Dahlia has stabilized at 8+ can
-- lift the setpoint to 8 without a code change.
--
-- Additive + idempotent (add column IF NOT EXISTS, integer, NOT NULL DEFAULT 7). Auto-
-- applied by the Control Tower migration-drift reconciler on merge to main (classifier
-- verdict is additive). Safe to re-apply.
alter table public.iteration_policies
  add column if not exists dahlia_rubric_min_composite integer not null default 7;

comment on column public.iteration_policies.dahlia_rubric_min_composite is
  'Min composite (0..10, integer) Max Phase-2 5-axis Dahlia rubric must clear before a creative flips ready-to-test (dahlia-researches-from-winners-flow-ad-library Phase 3). Read via resolveDahliaRubricMinComposite in src/lib/ads/dahlia-rubric-gate.ts; per-workspace tunable — the bar rises as Dahlia''s baseline improves. Default 7. NULL is treated as the DAHLIA_RUBRIC_MIN_COMPOSITE_DEFAULT (7) by the reader, but the column is NOT NULL so every row has an explicit value.';
