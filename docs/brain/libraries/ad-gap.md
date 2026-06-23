# `src/lib/ad-gap.ts` — Ad Creative Scout gap-finding layer

The **comparison half** of the Ad Creative Scout ([[../specs/ad-creative-scout]], M2 of [[../goals/acquisition-research-engine]]). The capture half ([[adlibrary]] + [[creative-skeleton]]) stores the complete AdLibrary payload per competitor ad; this file surfaces the competitor winning **angles we don't run** as concrete recommendations with supporting ad evidence.

**File:** `src/lib/ad-gap.ts`

## Exports

| Export | Notes |
|---|---|
| `buildAdGapReport(workspaceId, { minBrands?, minDaysRunning? })` | → `AdGapReport`. Clusters competitor angles, subtracts ours, ranks the gaps |
| `AdGapReport` / `AdGapRecommendation` / `AdEvidence` | types |

## How it works (deterministic, on-demand — no LLM spend)

1. **Competitor side** — analyzed/shortlisted [[../tables/creative_skeletons]] rows with an `advertiser` + an angle (`mechanism_claim`, fallback `hook`).
2. **Ours** — active [[../tables/product_ad_angles]] (`hook_one_liner`/`pain_now`/`desired_outcome`/`lead_benefit_anchor`/`meta_primary_text`/`meta_headline`) → a token corpus of the angles we already run.
3. **Cluster** competitor angles by greedy token-overlap (Jaccard ≥ 0.34), tracking distinct **brands**, max `days_running`, summed `estimated_spend`.
4. **Gap test** — a cluster whose tokens don't overlap the ours-corpus (Jaccard < 0.12) is an angle **we don't run** → a recommendation. Each carries the competitor `formats`/`offers`/`ctas` (the format/offer/CTA facets the spec calls for) + evidence ads (advertiser, longevity, spend, `destination_domain`, `image_url`).
5. **Rank** by independent-brand recurrence → longevity → spend. Single-ad metrics never rank; cross-brand repetition is the signal (mirrors [[creative-skeleton]] `buildPatternMatrix`).

## Surfaced by
`GET /api/ads/creative-finder/gaps?workspaceId=&minBrands=&minDaysRunning=` (owner/admin only).

## North star
PROPOSES gaps with evidence; the [[../functions/growth]] director approves what becomes an ad iteration. Bounded proxy (cross-brand angle recurrence) under an objective-owner — see [[../operational-rules]] § North star.

## Reads (not written)
- [[../tables/creative_skeletons]] (competitor angles + full payload)
- [[../tables/product_ad_angles]] (the angles we already run)

## Related
[[../specs/ad-creative-scout]] · [[../goals/acquisition-research-engine]] · [[adlibrary]] · [[creative-skeleton]] · [[competitors]] · [[../tables/creative_skeletons]] · [[../specs/landing-page-scout]] · [[../inngest/creative-finder]]
