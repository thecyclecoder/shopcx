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
| `extractCtaTarget(hrefs, entryUrl)` | Funnel Teardown Scout Phase 1 ([[../specs/funnel-teardown-scout]]): given all `a[href]` on a rendered lander + its URL, resolve to absolute, drop anchors + non-http + legal/footer paths + same-hostname internal links, keep only OUTBOUND URLs sharing the entry's registrable domain (same-or-related brand — never third parties), and rank by frequency. → the most-repeated outbound URL (the funnel's next-step CTA), or `null` if none qualify. |
| `DEFAULT_FUNNEL_DEPTH` | The bounded funnel-walk depth (`3`): entry lander → next → next-next. Checkout is Tool 5 and out of scope. |
| `deconstructLander(workspaceId, snapshot, opts?)` | Funnel Teardown Scout Phase 2 ([[../specs/funnel-teardown-scout]]): the landing-page analog of [[creative-skeleton]] `visionDeconstructFrames`. Normalizes each chapter shot with sharp (fit `1568px`, JPEG q82) to stay under the vision size limit, sends the ordered chapters to `OPUS_MODEL`, and extracts `{ page_type, offer_structure, big_promise, beats[], tactics[] }`. Idempotent (skips a snapshot that already has `page_type` + `skeleton`); cost-bounded to `DECONSTRUCT_MAX_CHAPTERS` chapters. Persists the result on the row + logs [[ai-usage]] with `purpose:'lander-skeleton-vision'`. |
| `DECONSTRUCT_MAX_CHAPTERS` | Max chapter shots sent to vision per step (`8`) — bounds Opus spend. |
| `LanderTarget` / `ChapterStat` / `AnalyzeResult` / `EnactResult` / `LanderDeconstruction` / `LanderSkeleton` | types |

## How the pipeline works

1. **Capture (box script).** `scripts/landing-page-snapshot.ts` reads `loadLanderTargets`, renders each at a 390×844 phone viewport, and captures per-chapter shots — ours one per `<section data-section>` (StorefrontChapterTracker anchors, paired with `loadChapterStats`), competitors one per viewport-height scroll step. Shots upload to `lander-shots`; a `lander_snapshots` row is written (`captured`/`blocked`/`failed`). A bot-blocked lander is logged + skipped. **Funnel walk (Phase 1):** for a competitor entry, after the capture the script also collects every `a[href]`, calls `extractCtaTarget` to pick the primary outbound same-brand CTA, and follows it as the next step (`funnel_step++`, same `funnel_root_url`) up to `DEFAULT_FUNNEL_DEPTH`. A blocked step stops that branch; the URL dedup prevents a re-capture within one run. **Skeleton (Phase 2):** each captured step then runs `deconstructLander`, which vision-analyzes the ordered per-chapter shots and stores `page_type` + `skeleton` on the row — so the advertorial and PDP steps each carry their own structural skeleton.
2. **Vision gap-analysis.** `analyzeLanderGaps` (also fired async by [[../inngest/landing-page-scout]] on `ads/landing-page-scout.analyze`) bounds cost (≤4 competitors × 6 chapters + our 8 chapters), fetches each signed shot as base64 (mirrors [[creative-skeleton]]'s vision call), and asks the model for gaps ≥2 competitors show that we lack → `{ gap_type, title, rationale, route, target_slug? }`. Each becomes a proposed recommendation. Token spend logged via [[ai-usage]] (`purpose: 'landing-page-scout-gap-analysis'`).
3. **Approve → route.** The owner approves → `enactRecommendationRoute` enqueues a Build or stands up an optimizer experiment draft.

## Gotchas

- **No Playwright import here** — keep this module serverless-bundleable; capture lives only in the script.
- **The ad-destination bridge uses `landing_page_url` (the real advertorial).** `adDestinationsForBrand` matches [[../tables/creative_skeletons]] on `seed_keyword` (== `competitors.brand` — NOT `advertiser`, the display name, which never matched) and PREFERS the full `landing_page_url` column (e.g. `https://learn.erthlabs.co/women50` — the actual advertorial WITH path), falling back to `https://{destination_domain}` only when absent. **The bare-domain root frequently 404s** (advertorials live at a slug), so surfacing only the domain used to yield dead targets. `pdp_urls` remains a breadth fallback. We never invent a URL.
- **optimizer route needs a `product_id`** — `storefront_experiments.product_id` is NOT NULL; `enactRecommendationRoute` returns an error if absent.
- **Vision needs both sides** — `analyzeLanderGaps` returns `{ skipped }` unless there's ≥1 captured competitor snapshot AND our snapshot.
- **M5 grade suppression** — `analyzeLanderGaps` skips proposing a gap whose `gap_type` was down-weighted by the gap-grade loop ([[acquisition-gap-grader]] `loadSuppressedGapTypes`), reported as `skippedSuppressed` — the loop stops re-surfacing low-value types ([[../specs/acquisition-research-loop-grading]]).

## Callers

- `scripts/landing-page-snapshot.ts` (capture + `loadChapterStats` + `analyzeLanderGaps`).
- [[../inngest/landing-page-scout]] (`analyzeLanderGaps`), re-fired on cadence by [[../inngest/acquisition-research-cadence]].
- `src/app/api/ads/lander-scout` (list snapshots / fire analyze) + `src/app/api/ads/lander-recommendations` (list / approve-reject → `enactRecommendationRoute`).

## Related

[[../specs/landing-page-scout]] · [[../tables/lander_snapshots]] · [[../tables/lander_recommendations]] · [[competitors]] · [[../specs/ad-creative-scout]] · [[../specs/storefront-optimizer]]
