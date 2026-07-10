# `src/lib/media-buyer/meta-cpa-signal.ts`

The **Meta-native trusted signal** for the Media Buyer ([[media-buyer-agent|Bianca]]). CEO decision (2026-07-10): for Meta-based media buying we **trust Meta's own reported conversions** rather than our internal order-match, which structurally can't resolve Shopify-destined ad revenue (Meta owns that truth). See [[media-buyer-agent]].

## Why
The old winner path ([[../ads/winning-creative-detect]] `detectWinners`) scores ROAS off [[../tables/meta_attribution_daily]] — our internally-*resolved* revenue. For ads pointing at the Shopify PDP, resolve is near-zero, so the internal-coverage sensor-trust gate reads **red** and no winner ever crowns. This module reads Meta's **reported** numbers instead — spend + purchases per adset from [[../tables/iteration_scorecards_daily]] (level=`adset`, sourced from [[../tables/meta_insights_daily]] `action_values[purchase]`).

## Signal (CPA, not LTV-scaled ROAS)
First-order ROAS on a subscription product is <1 (profit is in reorders), so winners key off **CPA**, not a ROAS multiple:
- **`detectMetaCpaWinners`** — crown an adset when Meta-reported **CPA (spend ÷ purchases) ≤ `crownMaxCpaCents`** AND **spend ≥ `crownMinSpendCents`** (the verdict floor). Ranked by CPA asc; resolves each winning adset's dominant child ad + source `ad_campaign`/angle (via [[../tables/ad_publish_jobs]]`.meta_ad_id`) into the `DetectedWinner` shape the plan/amplifier consume.
- **`detectMetaCpaLosers`** — **trim early**: an adset with spend ≥ `earlyTrimMinSpendCents` and either **no purchases** yet or a **CPA already worse than crown** is clearly not converting.
- **`hasFreshMetaSignal`** — the trust gate under trust-Meta: is the newest adset scorecard ≤ `META_SIGNAL_MAX_AGE_DAYS` (3d) old? (freshness replaces internal-resolve coverage).

## Wiring
[[media-buyer-agent]] `runMediaBuyerLoop` uses this module when the active [[../tables/iteration_policies]] row has **`trust_meta_reported_signal=true`** + the CPA knobs set (`crown_max_cpa_cents`, `crown_min_spend_cents`, `early_trim_min_spend_cents`). It then (a) gates on `hasFreshMetaSignal` instead of the internal-coverage denial, (b) detects winners/losers here, and (c) the plan's promote step skips the LTV-scaled ROAS re-check (winners are already CPA-crowned). Superfoods live config (2026-07-10): CPA ≤ $150, spend ≥ $450, early-trim ≥ $200, $500/day cohort ceiling.

## Related
[[media-buyer-agent]] · [[../ads/winning-creative-detect]] · [[meta/decision-engine|decision-engine]] (the `IterationPolicy` contract) · [[../tables/iteration_scorecards_daily]] · [[../tables/meta_insights_daily]] · [[media-buyer-agent]].
