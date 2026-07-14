# `src/lib/media-buyer/meta-cpa-signal.ts`

The **Meta-native trusted signal** for the Media Buyer ([[media-buyer-agent|Bianca]]). CEO decision (2026-07-10): for Meta-based media buying we **trust Meta's own reported conversions** rather than our internal order-match, which structurally can't resolve Shopify-destined ad revenue (Meta owns that truth). See [[media-buyer-agent]].

## Why
The old winner path ([[../ads/winning-creative-detect]] `detectWinners`) scores ROAS off [[../tables/meta_attribution_daily]] — our internally-*resolved* revenue. For ads pointing at the Shopify PDP, resolve is near-zero, so the internal-coverage sensor-trust gate reads **red** and no winner ever crowns. This module reads Meta's **reported** numbers instead — spend + purchases per adset from [[../tables/iteration_scorecards_daily]] (level=`adset`, sourced from [[../tables/meta_insights_daily]] `action_values[purchase]`).

## Crown on cumulative CPA (not LTV-scaled ROAS)
First-order ROAS on a subscription product is <1 (profit is in reorders), so winners key off **CPA**:
- **`detectMetaCpaWinners`** — crown an adset when Meta-reported **CPA (spend ÷ purchases) ≤ `crownMaxCpaCents`** AND **cumulative lifetime spend ≥ `crownMinSpendCents`** (the verdict floor — Σ `meta_insights_daily` over the adset's life, NOT a rolling 7-day window that a low-budget adset caps out below). Ranked by CPA asc; resolves each winning adset's dominant child ad + `ad_campaign`/angle into the `DetectedWinner` shape.
- **`hasFreshMetaSignal`** — the trust gate under trust-Meta: is the newest adset scorecard ≤ `META_SIGNAL_MAX_AGE_DAYS` (3d) old? (freshness replaces internal-resolve coverage).

## Kill on the crown/kill decision-tree (Phase 2 — parity with `tierForTest`)
**`detectMetaCpaLosers`** applies **`isDecisionTreeKill`** — the pure predicate that unifies the media-buyer's kill decision with the dashboard's `tierForTest` grader ([[../specs/media-buyer-kill-on-decision-tree-retire-roas-floor]] Phase 2). Two sources, evaluated in order:

**(a) Dud-tier kill — 1:1 parity with [[../ads/testing-results-sdk]] `tierForTest === 'dud'`.** An agent kill and a `/ad-testing-results` "dud" badge never disagree.
- **Deadline dud** — `spend ≥ maxTestSpendCents` AND (`purchases === 0` OR `cac > holdBandMaxCpaCents`): full runway spent without converting to the profit band → retire the slot.
- **Early dud** — `spend ≥ earlyTrimMinSpendCents` AND `purchases === 0`: real spend with zero conversions → don't wait for the deadline.

**(b) EARLY leading-signal trim** — validated on real Amazing Coffee laggards (winners $18–65/ATC, dead ones $100–152; a 9.8%-CTR ad still bombed at $152/ATC — CTR alone lies). **Converter short-circuit fires FIRST**: any `purchases > 0` adset RETURNS the branch (a converter is NEVER trimmed on a leading signal — the deadline dud is the only way a converter dies). Then past `earlyTrimMinSpendCents` an adset with 0 purchases is a laggard when ANY of:
- **cost-per-ATC (spend ÷ `add_to_cart`) > `trimMaxCostPerAtcCents`** — the primary signal (needs ≥ `MIN_ATC_FOR_COST_SIGNAL`=3 ATCs so 1-ATC noise can't trigger), OR
- **CPM > `trimMaxCpmCents`** — Meta charging a premium (poor relevance), OR
- **≥ `MIN_CLICKS_FOR_ZERO_ATC`=20 clicks but ZERO add-to-carts** (only when the account has ATC data — guards pre-backfill false positives).

Because `spend ≥ earlyTrimMinSpendCents` AND `purchases === 0` is exactly `tierForTest`'s early-dud rule, the leading-signal branch is a strict subset of (a) and therefore a **no-op for kill decisions** — kept for auditability and as a seam if the `earlyTrim` thresholds ever diverge.

**Retired (Phase 2):** the legacy (S) slow-kill (converter above `holdBandMaxCpaCents` past `crownMinSpendCents` pre-deadline) and (F1) 0-purchase-past-`crownMinSpendCents` backstop — folded into `tierForTest`'s deadline / early-dud rules.

**Fix 1 (Phase 3 — pre-merge parity fix):** the pre-merge spec-test's kill-set-vs-dud-set parity check failed on `MB Tabs · skeptic-bloat` (spend $529, 2 purchases, 5 ATC, cost-per-ATC ≈ $105): tierForTest returned `testing` but the leading-signal path returned kill=true because the old HOLD-band converter guard (`cpa ≤ hold_band`) let CAC $264 slip through ($44 over the $220 band). The durable fix widens the guard to `purchases > 0` (the invariant above), restoring `kill_set == dud_set` for every input. The spec's skeptic v3 protection (`$678 spend, 3 sales, CAC $226 — 'testing' tier`) is preserved via the same guard.

## Dominant-child-ad resolution (audit trail)
`dominantChildAdId(admin, { workspaceId, metaAdsetId })` — the winner/loser/reactivation paths all cite the **highest-spend child ad** of the qualifying adset so the audit trail names the CREATIVE, not just the ad set. Because [[../tables/meta_ads]] carries no `spend_cents` column (ad→adset mapping only; spend lives in [[../tables/meta_insights_daily]]), the helper (1) reads child ad ids from `meta_ads` (workspace-scoped), (2) sums `spend_cents` from `meta_insights_daily` at `level='ad'` over the 180-day lifetime lookback, (3) returns the ad id with the highest summed spend. Fallbacks: the first child ad id if insights show none, or the adset id itself if `meta_ads` has no children yet. `resolveWinnerSource`, `detectMetaCpaLosers`, and `detectMetaCpaReactivations` all share this helper — a single site to change if the "dominant child" rule ever grows a recency window or a tie-break. Before this helper existed, the three sites queried `.from('meta_ads').select('meta_ad_id, spend_cents').order('spend_cents')` and errored on every pass because the column doesn't exist; Postgres logged a schema-drift error and the audit fell back to the adset id.

## Wiring
[[media-buyer-agent]] `runMediaBuyerLoop` uses this module when the active [[../tables/iteration_policies]] row has **`trust_meta_reported_signal=true`** + the CPA knobs set (`crown_max_cpa_cents`, `crown_min_spend_cents`, `early_trim_min_spend_cents`). It then (a) gates on `hasFreshMetaSignal` instead of the internal-coverage denial, (b) detects winners/losers here, and (c) the plan's promote step skips the LTV-scaled ROAS re-check (winners are already CPA-crowned). Superfoods live config (2026-07-10): CPA ≤ $150, spend ≥ $450, early-trim ≥ $200, $500/day cohort ceiling.

## Related
[[media-buyer-agent]] · [[../ads/winning-creative-detect]] · [[meta/decision-engine|decision-engine]] (the `IterationPolicy` contract) · [[../tables/iteration_scorecards_daily]] · [[../tables/meta_insights_daily]] · [[media-buyer-agent]].
