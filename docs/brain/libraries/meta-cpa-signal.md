# `src/lib/media-buyer/meta-cpa-signal.ts`

The **Meta-native trusted signal** for the Media Buyer ([[media-buyer-agent|Bianca]]). CEO decision (2026-07-10): for Meta-based media buying we **trust Meta's own reported conversions** rather than our internal order-match, which structurally can't resolve Shopify-destined ad revenue (Meta owns that truth). See [[media-buyer-agent]].

## Why
The old winner path ([[../ads/winning-creative-detect]] `detectWinners`) scores ROAS off [[../tables/meta_attribution_daily]] — our internally-*resolved* revenue. For ads pointing at the Shopify PDP, resolve is near-zero, so the internal-coverage sensor-trust gate reads **red** and no winner ever crowns. This module reads Meta's **reported** numbers instead — spend + purchases per adset from [[../tables/iteration_scorecards_daily]] (level=`adset`, sourced from [[../tables/meta_insights_daily]] `action_values[purchase]`).

## Crown on cumulative CPA (not LTV-scaled ROAS)
First-order ROAS on a subscription product is <1 (profit is in reorders), so winners key off **CPA**:
- **`detectMetaCpaWinners`** — crown an adset when Meta-reported **CPA (spend ÷ purchases) ≤ `crownMaxCpaCents`** AND **cumulative lifetime spend ≥ `crownMinSpendCents`** (the verdict floor — Σ `meta_insights_daily` over the adset's life, NOT a rolling 7-day window that a low-budget adset caps out below). Ranked by CPA asc; resolves each winning adset's dominant child ad + `ad_campaign`/angle into the `DetectedWinner` shape.
- **`hasFreshMetaSignal`** — the trust gate under trust-Meta: is the newest adset scorecard ≤ `META_SIGNAL_MAX_AGE_DAYS` (3d) old? (freshness replaces internal-resolve coverage).

## Trim early on LEADING signals (not lagging cost-per-purchase)
**`detectMetaCpaLosers`** — cost-per-purchase is a *lagging* signal (by the time it's bad the spend is wasted). The early trim reads the signs **Meta doesn't like the ad**, long before purchases accumulate — validated on real Amazing Coffee laggards (winners $18–65/ATC, dead ones $100–152; a 9.8%-CTR ad still bombed at $152/ATC — CTR alone lies). Past `earlyTrimMinSpendCents`, an adset is a laggard when ANY of:
- **cost-per-ATC (spend ÷ `add_to_cart`) > `trimMaxCostPerAtcCents`** — the primary signal (needs ≥ `MIN_ATC_FOR_COST_SIGNAL`=3 ATCs so 1-ATC noise can't trigger), OR
- **CPM > `trimMaxCpmCents`** — Meta charging a premium (poor relevance), OR
- **≥ `MIN_CLICKS_FOR_ZERO_ATC`=20 clicks but ZERO add-to-carts** (only when the account has ATC data — guards pre-backfill false positives).

**Converter guard:** NEVER trim an adset already producing purchases at **CPP ≤ `crownMaxCpaCents`** — it's a winner-in-progress (real case: Tabs Test 02, cost-per-ATC $94 but 2 purchases @ $47 CPP — ATC undercounts at low volume). The ATC signal comes from `meta_insights_daily.add_to_cart` (Meta's `actions[add_to_cart]`, ingested in [[meta/performance|performance]]).

## Wiring
[[media-buyer-agent]] `runMediaBuyerLoop` uses this module when the active [[../tables/iteration_policies]] row has **`trust_meta_reported_signal=true`** + the CPA knobs set (`crown_max_cpa_cents`, `crown_min_spend_cents`, `early_trim_min_spend_cents`). It then (a) gates on `hasFreshMetaSignal` instead of the internal-coverage denial, (b) detects winners/losers here, and (c) the plan's promote step skips the LTV-scaled ROAS re-check (winners are already CPA-crowned). Superfoods live config (2026-07-10): CPA ≤ $150, spend ≥ $450, early-trim ≥ $200, $500/day cohort ceiling.

## Related
[[media-buyer-agent]] · [[../ads/winning-creative-detect]] · [[meta/decision-engine|decision-engine]] (the `IterationPolicy` contract) · [[../tables/iteration_scorecards_daily]] · [[../tables/meta_insights_daily]] · [[media-buyer-agent]].
