# `src/lib/ads/creative-sourcing.ts`

The shared SDK for **where great ad ideas come from** + **how ads actually perform** (CEO 2026-07-11). Dahlia (sources angles), Bianca (reads signal), and Max (supervises) all call this one surface instead of re-deriving it from raw Meta/DB queries. It codifies the ad-hoc analysis that validated our signal model.

## The three idea pools + the analyzer
- **`getProvenCompetitorAngles(admin, ws, {minDaysRunning, productId, niche, limit})`** — the [[../tables/creative_skeletons]] competitor library, RANKED by `days_running` (longevity = a competitor is profitably scaling it = a validated angle). **Pass `productId`** (CEO 2026-07-12) → reads ONLY skeletons the [[../inngest/creative-scout]] tagged for THAT product's deliberately-chosen competitors (`creative_skeletons.product_id`) — the imitate→innovate path, a product imitates only its own shelf. `niche` is the LEGACY substring filter (e.g. "coffee", "weight"), superseded by `productId` and ignored when `productId` is set. [[creative-agent|Dahlia]] `stockProduct` now passes `productId` (the coffee/weight niche hack is gone). **The strongest pool** — real market-validated hooks.
- **`getOurWinningAngles(admin, ws, metaAccountId, {maxCpaCents, minSpendCents})`** — our OWN best-performing ads ranked by cost-per-ATC then CPP — "what works for US", the **exploit seed** (the concepts to make variations of).
- **`analyzeAccountAds(token, metaAccountId, {datePreset})`** — the per-ad performance analyzer: spend, purchases, CPP, ATC, **cost-per-ATC**, **CPM**, CTR, reactions/saves/shares. Meta ground truth.
- *(Web DR-angle research — a future pool.)*

## The validated signal model (why these fields)
Proven on **99 historical ads** (45 winners, 24 losers): **cost-per-ATC** ($25 winners vs $79 losers) and **CPM** ($93 vs $148) discriminate winners. **CTR + reactions are TRAPS** — losers click 2× and react 7× *more* (clickbait). So the analyzer surfaces CTR/engagement for visibility but winners are chosen on cost-per-ATC + CPM. This is the same model [[meta-cpa-signal]] trims/crowns on.

## Consumers
[[creative-agent|Dahlia]] should draw her explore pool from `getProvenCompetitorAngles` + `getOurWinningAngles` (not just product reviews); [[media-buyer-agent|Bianca]] reads `analyzeAccountAds`; **Max** uses all three for supervision + research. [[creative-brief]] · [[creative-learning]] · [[../tables/creative_skeletons]].
