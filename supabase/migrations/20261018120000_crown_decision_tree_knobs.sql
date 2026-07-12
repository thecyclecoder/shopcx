-- Crown/kill decision-tree knobs (CEO Dylan, 2026-07-12) — the media-buyer test-loop verdict bands.
--
-- Deep-research (2026-07-12) verdict: the old crown rule (CPA ≤ $150 at ≥ $450 spend) crowned on only
-- ~3 purchases — statistical noise — before pouring real scale budget in. Consensus is 7+ days AND
-- ~8-10 purchases at/under target CPA to crown. And the $450→deadline MIDDLE ZONE was undefined: an ad
-- converting profitably at, say, $160 CPA could get trimmed by the leading-signal logic. This migration
-- adds three configurable knobs so the whole decision tree is explicit + tunable per policy (Meta moves
-- fast, so these are config, not hard-coded):
--
--   • crown_min_purchases      — a crown ALSO requires this many purchases (not just CPA ≤ crown at
--                                ≥ crown_min_spend). Default 8. Kill stays fast; only CROWNING got patient.
--   • hold_band_max_cpa_cents  — the profit/kill CPA ceiling (~LTV/1.5). CPA between crown_max_cpa and this
--                                = HOLD (converting profitably, keep running); above it = slow-kill. Widens
--                                the converter guard so a profitable ad is never trimmed on a leading signal.
--   • max_test_spend_cents     — decision deadline. An adset that reaches this spend WITHOUT crowning is
--                                retired to free the $150/day test slot. Default $1,200 (~8 test-days).
--
-- See docs/brain/reference/meta-scaling-methodology.md (decision tree) · src/lib/media-buyer/meta-cpa-signal.ts.

alter table public.iteration_policies
  add column if not exists crown_min_purchases integer not null default 8,
  add column if not exists hold_band_max_cpa_cents integer not null default 22000,
  add column if not exists max_test_spend_cents integer not null default 120000;

comment on column public.iteration_policies.crown_min_purchases is
  'A crown requires >= this many purchases (in addition to CPA <= crown_max_cpa_cents at >= crown_min_spend_cents). Default 8 — ~3 purchases ($450 at $150 CPA) is statistical noise; 8+ at target is real signal before scaling. CEO 2026-07-12.';
comment on column public.iteration_policies.hold_band_max_cpa_cents is
  'Profit/kill CPA ceiling (~LTV/1.5). CPA in (crown_max_cpa_cents, hold_band_max_cpa_cents] = HOLD (keep running, profitable but not yet a scale winner); CPA > this after >= crown_min_spend_cents = slow-kill. Also the widened converter guard (a converting ad <= this is never trimmed on leading signals). Default $220.';
comment on column public.iteration_policies.max_test_spend_cents is
  'Decision deadline: an active test adset that reaches this cumulative spend WITHOUT crowning is retired to free the test slot for a fresh creative. Default $1,200 (~8 test-days at $150/day). CEO 2026-07-12.';
