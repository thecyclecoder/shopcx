# Dashboard · research/teardowns

The **Lander Teardowns viewer** — Growth's owner-facing window into the funnels captured by the [[../libraries/landing-page-scout|Landing Page Scout]] (Tool 4 of the [[../goals/acquisition-research-engine|Acquisition Research Engine]]). The productized version of the manual Erth teardown: the ordered funnel map + each step's page-type-aware skeleton + the mobile chapter filmstrip.

**Route:** `/dashboard/research/teardowns` · **owner-only** (Phase 2 — page + nav item, not yet built).

## Phase status

- **Phase 1 (this PR)** — the read API only. `GET /api/ads/lander-teardowns` returns the captured competitor funnels grouped by `funnel_root_url` with signed chapter URLs. No page yet.
- **Phase 2** — the Research → Lander Teardowns page + sidebar item that consumes this API.

## API endpoints called

- `GET /api/ads/lander-teardowns?workspaceId=&productId=&competitorId=` → captured **competitor** funnels. Grouped by [[../tables/lander_snapshots]] `funnel_root_url` (fallback: `competitor_id`+`url` for legacy single-step rows), steps ordered by `funnel_step`. Each step returns `{ id, url, brand, status, funnel_step, page_type, skeleton, cta_target_url, captured_at, chapters: [{ index, label, signed_url }] }`. Signed URLs come from [[../libraries/landing-page-scout]] `signLanderShot` (1-hour TTL) against the private `lander-shots` bucket. `is_ours=true` rows are excluded — this surface is the competitor teardown view. Owner-only (403 for admin/member).

## Data source

- [[../tables/lander_snapshots]] — the captured per-chapter mobile snapshots (written by `scripts/landing-page-snapshot.ts`). `page_type` + `skeleton` come from [[../libraries/landing-page-scout]] `deconstructLander` (null until the vision pass has run on a step).
- [[../libraries/landing-page-scout]] `signLanderShot` — short-lived signed URLs into the private `lander-shots` bucket.

## Related

[[../specs/funnel-teardown-scout]] · [[../libraries/landing-page-scout]] · [[../tables/lander_snapshots]] · [[marketing__acquisition]] · [[marketing__landers]].
