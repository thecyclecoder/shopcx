# Landing Page Scout — per-chapter lander snapshots + gap analysis

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M3)
**Blocked-by:** [[competitor-scout]] (shipped ✅)

Snapshot competitor landing pages **and ours**, mobile, broken into chapters, and vision-analyze the **gaps** → PDP enhancement recommendations that route to Build (new components) or the [[storefront-optimizer]] (experiments).

## Sourcing the competitor landers (the bridge)
- **From [[ad-creative-scout]]'s captured `ecom_advertiser_id`/store domains** — the *exact pages competitors spend to drive paid traffic to* (highest signal; different ads → different landers).
- **+ [[competitor-scout]]'s canonical PDP URLs** for breadth.

## What it does
- **Mobile, per-chapter snapshots** — render at a phone viewport via the headless browser (`scripts/spec-test-browser-check.ts`), scroll to each section, capture per-chapter screenshots (ours uses `StorefrontChapterTracker` anchors → each shot pairs with that chapter's funnel stats: dwell %, CTA rate).
- **Vision gap-analysis** — compare competitor landers vs ours: sections/proof/structure/offers they have that we lack (comparison table, founder story, ingredient breakdown, guarantee badges, …).
- **Enhancement recommendations** — each gap → a recommendation that routes to **Build** (a missing component spec, mirroring the optimizer's missing-tool→build) or the **Optimizer** (a structural experiment). Supervisable: proposes, owner approves.

## Phase 1 — mobile per-chapter snapshotter + vision gap-analysis → recommendations
Mobile snapshot pipeline (competitor URLs from [[ad-creative-scout]] + [[competitor-scout]], + our own landers), per-chapter capture stored to a private bucket, vision gap-analysis pass, recommendation records that route to Build/optimizer. Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[ad-creative-scout]] · [[storefront-optimizer]] · [[../lifecycles/customer-portal]] (chapter tracking) · [[../specs/spec-test-deep-verification]] (headless browser).

**Built (code-complete, tsc-clean; migration NOT yet applied to prod):**
- `supabase/migrations/20260623130000_landing_page_scout.sql` — the `lander_snapshots` + `lander_recommendations` tables (workspace-member SELECT / service-role write RLS; snapshot status `captured`/`blocked`/`failed`; recommendation `route` ∈ `build`/`optimizer`, deduped on `(workspace_id, dedup_key)`). Apply via `scripts/apply-landing-page-scout-migration.ts` (also creates the private `lander-shots` bucket). Tables: [[../tables/lander_snapshots]] · [[../tables/lander_recommendations]].
- `src/lib/landing-page-scout.ts` ([[../libraries/landing-page-scout]]) — `loadLanderTargets` (competitor ad-destinations + PDP URLs + our PDPs), `loadChapterStats` (per-chapter funnel stats from `storefront_events`), `analyzeLanderGaps` (Opus vision gap-analysis → proposed recommendations), `enactRecommendationRoute` (build-job / optimizer-draft on approval), and the private-bucket storage helpers. **No Playwright import** (serverless-bundleable).
- `scripts/landing-page-snapshot.ts` — the box-only Playwright mobile per-chapter capture: ours one shot per `<section data-section>` (StorefrontChapterTracker anchors, paired with funnel stats), competitors one per viewport-height scroll step; uploads to `lander-shots`; writes `lander_snapshots`; runs the gap-analysis. Bot-blocked landers → `status='blocked'`, skipped.
- `src/lib/inngest/landing-page-scout.ts` ([[../inngest/landing-page-scout]]) — `landing-page-scout-analyze` on event `ads/landing-page-scout.analyze { workspaceId, productId? }`; registered in `registered-functions.ts`.
- `src/app/api/ads/lander-scout/route.ts` (GET snapshots w/ signed chapter URLs / POST fire analyze) + `src/app/api/ads/lander-recommendations/route.ts` (GET list) + `[id]/route.ts` (POST approve|reject → routes to Build/optimizer). Owner/admin gated, audit-stamped.

## Verification
- **Apply first:** `npx tsx scripts/apply-landing-page-scout-migration.ts` → `lander_snapshots` + `lander_recommendations` tables present and the private `lander-shots` bucket created.
- On the box, run `npx tsx scripts/landing-page-snapshot.ts --workspace-id <ws> --product-id <pid>` for a product with ≥1 **approved** competitor → produces mobile **per-chapter** `lander_snapshots` rows for each competitor lander (sourced from `competitors.pdp_urls`, or the captured ad destination once ad-creative-scout captures it) + our matching lander; `GET /api/ads/lander-scout?workspaceId=&productId=` returns them with signed chapter screenshot URLs (`status='captured'`).
- Our snapshot's `chapters[]` carry `avg_dwell_ms` / `view_to_cta_pct` / `reach_sessions` paired from `storefront_events` for that `data-section` chapter.
- The capture/`POST /api/ads/lander-scout { workspaceId, productId }` fires `ads/landing-page-scout.analyze`; within ~1–2 min `GET /api/ads/lander-recommendations?workspaceId=&status=proposed` returns concrete gaps (e.g. *"3 of 4 competitors show a comparison table above the fold; ours has none"*) each with `route` ∈ `build`/`optimizer`, `status='proposed'`.
- `POST /api/ads/lander-recommendations/{id} { workspaceId, action:"approve" }` on a `route='build'` rec → flips to `approved`, `route_result.agent_job_id` set (a queued [[../tables/agent_jobs]] `kind='build'` row); on a `route='optimizer'` rec (with a `product_id`) → `route_result.experiment_id` set (a `draft` [[../tables/storefront_experiments]] + control + variant arm). Re-POSTing returns `409 Already approved`.
- Negative: a competitor lander that fails to load (bot-block / 4xx) is written `status='blocked'` with an `error`, NOT a hard failure — the run continues + still analyzes the captured ones. `analyzeLanderGaps` returns `{ skipped }` (no recommendations) unless there's ≥1 captured competitor snapshot AND our snapshot. Recommendations never route until the owner approves (`analyzeLanderGaps` only writes `proposed`).
