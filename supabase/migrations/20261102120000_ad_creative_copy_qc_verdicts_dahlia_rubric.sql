-- ad_creative_copy_qc_verdicts.declared_intent + dahlia_rubric — Phase 2 of
-- dahlia-researches-from-winners-flow-ad-library. Max grades every Dahlia creative
-- INTENT-AWARE on a fixed 5-axis rubric (competitor_selection · temperature_selection ·
-- creative_quality · scroll_stopping · dr_consumer_psychology) — Dahlia declares the
-- audience temperature + purpose FIRST (Phase 1 CreativeIntent), Max is told what she
-- declared, and grades against that same declared intent. This migration is the durable
-- storage: two additive jsonb columns on the existing ad_creative_copy_qc_verdicts row so
-- the grade ledger is one shape (hard_gates + persuasion + scroll_stop + dahlia_rubric +
-- declared_intent + verdict_reason per QC attempt).
--
-- Shape pinned by src/lib/ads/creative-qa.ts:
--   declared_intent: { audience_temperature: 'cold'|'warm'|'hot', purpose: 'test-to-find-winner' } | null
--   dahlia_rubric:   {
--                      competitor_selection: {score:int 1..10, reason:string},
--                      temperature_selection: {score:int 1..10, reason:string},
--                      creative_quality: {score:int 1..10, reason:string},
--                      scroll_stopping: {score:int 1..10, reason:string},
--                      dr_consumer_psychology: {score:int 1..10, reason:string}
--                    } | null
--
-- ADVISORY only in Phase 2 — the parser fail-closes on a MALFORMED rubric (defense against
-- a rubric-mirror lie), but no code path uses it to gate a bin insert. Phase 3 (a later
-- session) wires the ready-to-bin threshold that reads dahlia_rubric to enforce the min
-- composite / trigger a revise loop. Nullable + no default so legacy rows survive unchanged;
-- new writes always populate a non-null value when the caller declared an intent + Max
-- scored the rubric (a hard-gate fail may leave dahlia_rubric null, same rule as
-- persuasion_rubric).
--
-- Additive + idempotent (add column IF NOT EXISTS). Safe to re-apply.
-- Applied by the Control Tower migration-drift reconciler's applyMergedMigrations path
-- once this PR merges to main (classifyMigrationSql → additive → auto-apply). No bespoke
-- pre-merge apply is required.
alter table public.ad_creative_copy_qc_verdicts
  add column if not exists declared_intent jsonb;

alter table public.ad_creative_copy_qc_verdicts
  add column if not exists dahlia_rubric jsonb;

comment on column public.ad_creative_copy_qc_verdicts.declared_intent is
  'Dahlia-declared intent envelope threaded into Max QC prompt (dahlia-researches-from-winners-flow-ad-library Phase 2). Shape: {audience_temperature:cold|warm|hot, purpose:test-to-find-winner}. NULL for a legacy M1 verdict that never declared one — new callers always populate it via Phase 1 resolveResearchIntent.';

comment on column public.ad_creative_copy_qc_verdicts.dahlia_rubric is
  'Max 5-axis rubric on Dahlia creative (dahlia-researches-from-winners-flow-ad-library Phase 2). Shape: { competitor_selection:{score:1..10, reason}, temperature_selection:{...}, creative_quality:{...}, scroll_stopping:{...}, dr_consumer_psychology:{...} }. Advisory-only in Phase 2 (grade ledger); Phase 3 wires the ready-to-bin threshold. NULL on a hard-gate fail (bounce is the signal — the rubric was not scored) OR a legacy verdict.';
