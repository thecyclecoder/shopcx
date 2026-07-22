-- factor-scores-reweight-selection-engine Phase 2 — the workspace-tunable "loser floor"
-- the picker's fresh-sample branch reads to exclude a significance-passed high-CPA
-- combination BEFORE the freshness-cooldown ledger even fires.
--
-- The pre-Phase-2 fresh branch filters retired angles via creative-learning's
-- MAX_FAILED_COMBOS_BEFORE_RETIRE (a count on the outcomes ledger) — blind to real
-- money-CPA. A combination whose ROAS is proven bad on real spend but hasn't yet hit
-- MAX_FAILED_COMBOS_BEFORE_RETIRE (because a lot of its tests are 'pending') keeps
-- re-entering the fresh sample and burning budget. This column pins the CPA above
-- which a passesGate combination is excluded from the fresh sample — the picker
-- reads it via factor-rollup-policies.ts `resolveFactorRollupThresholds`.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, no backfill). A workspace with a
-- NULL value falls through to the code default (DEFAULT_FACTOR_ROLLUP_THRESHOLDS
-- `maxAcceptableCpaCents = 25000` = $250, matches the spec's "default $250 in code").
-- The Phase-1 tuning knobs (`min_spend_cents`, `min_purchases`, `confidence`) are the
-- gate axes; this is the loser AXIS the gated numbers get COMPARED against — same
-- shape as the pre-existing knobs (nullable + code-default fallthrough) so a workspace
-- can turn the loser floor tighter or looser without touching code.
--
-- See docs/brain/specs/factor-scores-reweight-selection-engine.md Phase 2.

alter table public.factor_rollup_policies
  add column if not exists max_acceptable_cpa_cents bigint
    check (max_acceptable_cpa_cents is null or max_acceptable_cpa_cents >= 0);

comment on column public.factor_rollup_policies.max_acceptable_cpa_cents is
  'Loser CPA floor (cents) the picker''s fresh-sample branch reads to EXCLUDE a significance-passed high-CPA combination before the freshness-cooldown ledger fires. NULL = fall through to code default ($250). Set by factor-scores-reweight-selection-engine Phase 2; consumed via resolveFactorRollupThresholds() in factor-rollup-policies.ts. Combinations whose passesGate rollup row has cpa_cents > max_acceptable_cpa_cents are dropped from the fresh sample; theme-spread quota is halved for a theme whose byTheme row exceeds the same floor.';
