# Acquisition Research Hub — one surface for sets + findings + gap queue ✅

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M4)
**Blocked-by:** [[ad-creative-scout]], [[landing-page-scout]]

House it all together: one dashboard surface where the competitor sets, both scouts' findings, and the gap queue live — and where recommendations route to action.

## What it surfaces
- **Competitor sets** ([[competitor-scout]]) per product — approve/reject proposed competitors here.
- **Ad findings** ([[ad-creative-scout]]) — competitor winning ads (creative + captured copy/spend/longevity) + the ad-gap recommendations.
- **Landing findings** ([[landing-page-scout]]) — competitor vs our lander snapshots (per chapter) + the enhancement-gap recommendations.
- **The gap queue** — every surfaced gap (ad or lander) with its evidence, where the owner (or, later, the Growth director) **approves → routes to Build or the [[storefront-optimizer]]** as an experiment/component. Tracks gap → shipped → won.

## Phase 1 — the hub dashboard + the gap queue + routing ✅
A `/dashboard/.../acquisition` (owner-only) surface reading the `competitors` table + both scouts' findings; the gap queue with approve→route-to-Build/optimizer actions; gap-throughput stats (proposed → shipped → won). Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[ad-creative-scout]] · [[landing-page-scout]] · [[storefront-optimizer]].

**Built (code-complete, tsc-clean; migration NOT yet applied to prod):**
- `supabase/migrations/20260623140000_ad_gap_recommendations.sql` — the persisted, trackable queue for ad gaps (the ad-side mirror of `lander_recommendations`). Ad gaps were computed deterministically on demand by `buildAdGapReport` and never persisted — so they couldn't be approved/routed/tracked. Apply via `scripts/apply-ad-gap-recommendations-migration.ts`. Table: [[../tables/ad_gap_recommendations]].
- `src/lib/acquisition-hub.ts` ([[../libraries/acquisition-hub]]) — `loadHubData` (aggregates competitors + both scouts' findings + the merged gap queue + derived throughput), `materializeAdGaps` (idempotent persist of the ad-gap report), `enactAdGapRoute` (approve → an `agent_jobs` build for an ad-creative iteration). **Throughput is DERIVED** by joining each approved gap's route artifact (`agent_jobs.status='completed'` → shipped; `storefront_experiments.status='promoted'` → won).
- `src/app/api/ads/acquisition/route.ts` (GET hub payload, **owner-only**) + `src/app/api/ads/acquisition/gaps/[id]/route.ts` (POST approve|reject an ad gap → routes to Build). Lander gaps in the same queue approve via the existing `/api/ads/lander-recommendations/[id]`.
- `src/app/dashboard/marketing/acquisition/page.tsx` ([[../dashboard/marketing__acquisition]]) — throughput cards, product selector, the unified gap queue (approve & route / reject), and the competitor-set / ad-findings / lander-findings panels. Nav: owner-only **Acquisition** item under Marketing.

## Verification
- **Apply first:** `npx tsx scripts/apply-ad-gap-recommendations-migration.ts` → `ad_gap_recommendations` table present.
- As **owner**, open `/dashboard/marketing/acquisition` → the page loads with throughput cards (Proposed/Approved/Shipped/Won), a product selector, the gap queue, and the competitor-set / ad-findings / lander-findings panels. `GET /api/ads/acquisition?workspaceId=<ws>` returns `{ products, competitors, adFindings, landerSnapshots, gapQueue, throughput }`.
- For a workspace with `creative_skeletons` ad gaps: loading the hub materializes them — `select status, count(*) from ad_gap_recommendations where workspace_id=<ws> group by status` shows `proposed` rows (one per competitor angle we don't run, deduped on `dedup_key`); reloading does NOT duplicate them.
- On an `ad` gap, **Approve & route** (`POST /api/ads/acquisition/gaps/{id} { workspaceId, action:"approve" }`) → flips to `approved`, `route_result.agent_job_id` set (a queued [[../tables/agent_jobs]] `kind='build'` row, `spec_slug='ad-angle-…'`); re-POSTing returns `409 Already approved`. Once that build job reaches `status='completed'`, the gap shows **shipped** and the Shipped count increments.
- On a `lander` gap (route='build' or 'optimizer'), Approve routes via the existing `/api/ads/lander-recommendations/{id}`; an optimizer-routed gap whose experiment is `promoted` shows **won** and increments the Won count.
- Negative: a **non-owner** (admin/agent/…) GET `/api/ads/acquisition` → `403 Forbidden`, and the Acquisition nav item is hidden; an **unapproved** gap stays `proposed` with no `route_result` (nothing auto-routes — materialization only ever writes `proposed`).
