# `src/lib/landing-page-scout.ts` — Landing Page Scout

The serverless-runnable half of [[../specs/landing-page-scout]] (M3 of [[../goals/acquisition-research-engine]]): sources lander URLs, pairs our chapters with funnel stats, runs the vision gap-analysis, and enacts an approved recommendation's route. The mobile per-chapter **capture** is a box script (`scripts/landing-page-snapshot.ts`) — Playwright can't run in serverless, so it is NOT in this module. North-star: the vision pass only ever writes `status='proposed'`; routing happens only after owner approval.

## Exports

| Export | Notes |
|---|---|
| `LANDER_SHOTS_BUCKET` / `ensureLanderShotsBucket()` / `uploadLanderShot(path, buf)` / `signLanderShot(path, ttl)` | The private `lander-shots` Storage bucket (per-chapter screenshots, signed-URL reads). |
| `loadLanderTargets(workspaceId, productId?)` | → `LanderTarget[]` — competitor landers ([[../specs/ad-creative-scout]] ad destinations + [[../tables/competitors]] `pdp_urls`/domain) + our storefront PDP(s). Competitors must be `status='approved'`. |
| `loadChapterStats(workspaceId, productId?, days=30)` | → `Record<label, ChapterStat>` — per-chapter `reach_sessions` / `avg_dwell_ms` / `view_to_cta_pct` from [[../tables/storefront_events]] (`chapter_view`/`chapter_dwell`/`cta_click`). Paired into our snapshot's chapters. |
| `analyzeLanderGaps(workspaceId, productId?)` | The vision pass: loads the latest captured competitor + our snapshots, sends labelled per-chapter shots to [[ai-models]] `OPUS_MODEL` vision, writes proposed [[../tables/lander_recommendations]] (deduped). → `AnalyzeResult`. |
| `enactRecommendationRoute(rec, userId)` | Called by the approve action: route=`build` → [[../tables/agent_jobs]] build; route=`optimizer` → [[../tables/storefront_experiments]] draft + arms. → `{ ok, route_result, error? }`. |
| `LanderTarget` / `ChapterStat` / `AnalyzeResult` / `EnactResult` | types |

## How the pipeline works

1. **Capture (box script).** `scripts/landing-page-snapshot.ts` reads `loadLanderTargets`, renders each at a 390×844 phone viewport, and captures per-chapter shots — ours one per `<section data-section>` (StorefrontChapterTracker anchors, paired with `loadChapterStats`), competitors one per viewport-height scroll step. Shots upload to `lander-shots`; a `lander_snapshots` row is written (`captured`/`blocked`/`failed`). A bot-blocked lander is logged + skipped.
2. **Vision gap-analysis.** `analyzeLanderGaps` (also fired async by [[../inngest/landing-page-scout]] on `ads/landing-page-scout.analyze`) bounds cost (≤4 competitors × 6 chapters + our 8 chapters), fetches each signed shot as base64 (mirrors [[creative-skeleton]]'s vision call), and asks the model for gaps ≥2 competitors show that we lack → `{ gap_type, title, rationale, route, target_slug? }`. Each becomes a proposed recommendation. Token spend logged via [[ai-usage]] (`purpose: 'landing-page-scout-gap-analysis'`).
3. **Approve → route.** The owner approves → `enactRecommendationRoute` enqueues a Build or stands up an optimizer experiment draft.

## Gotchas

- **No Playwright import here** — keep this module serverless-bundleable; capture lives only in the script.
- **The ad-destination bridge degrades gracefully.** `adDestinationsForBrand` scans [[../tables/creative_skeletons]] `raw` for a destination URL; today that field is rarely captured, so competitor-scout `pdp_urls` is the reliable source. It lights up automatically once [[../specs/ad-creative-scout]] captures ad destinations. We never invent a URL.
- **optimizer route needs a `product_id`** — `storefront_experiments.product_id` is NOT NULL; `enactRecommendationRoute` returns an error if absent.
- **Vision needs both sides** — `analyzeLanderGaps` returns `{ skipped }` unless there's ≥1 captured competitor snapshot AND our snapshot.

## Callers

- `scripts/landing-page-snapshot.ts` (capture + `loadChapterStats` + `analyzeLanderGaps`).
- [[../inngest/landing-page-scout]] (`analyzeLanderGaps`).
- `src/app/api/ads/lander-scout` (list snapshots / fire analyze) + `src/app/api/ads/lander-recommendations` (list / approve-reject → `enactRecommendationRoute`).

## Related

[[../specs/landing-page-scout]] · [[../tables/lander_snapshots]] · [[../tables/lander_recommendations]] · [[competitors]] · [[../specs/ad-creative-scout]] · [[../specs/storefront-optimizer]]
