# Dashboard · research/teardowns

The **Lander Teardowns viewer** — Growth's owner-facing window into the funnels captured by the [[../libraries/landing-page-scout|Landing Page Scout]] (Tool 4 of the [[../goals/acquisition-research-engine|Acquisition Research Engine]]). The productized version of the manual Erth teardown: the ordered funnel map + each step's page-type-aware skeleton + the mobile chapter filmstrip.

**Route:** `/dashboard/research/teardowns` · **owner-only** (client gates on `workspace.role === "owner"` and shows the same owner-only fallback the sibling Research surfaces use; the API also 403s server-side).

## Layout

For each competitor funnel returned by the API:

- **Funnel map** — the ordered steps (Step 0 · advertorial → Step 1 · single-bundle PDP → …), each labeled with its `page_type` and host/path.
- **Per-step skeleton panel** — `big_promise` (headline quote), `offer_structure`, the ordered beats (`beat` handle + one-sentence `does` + chapter refs), and the tactics chip row. Renders a "Not yet deconstructed" hint when `skeleton` is null (the vision pass hasn't run for that step) — chapters below still render from the raw capture.
- **Chapter filmstrip** — the mobile screenshots via the API's `signed_url`, in scroll order, labeled with the chapter's `label` + index.
- **CTA line** — each step lists the extracted `cta_target_url` when present (the outbound step this page funnels to).

## API endpoints called

- `GET /api/ads/lander-teardowns?workspaceId=&productId=&competitorId=` → captured **competitor** funnels. Grouped by [[../tables/lander_snapshots]] `funnel_root_url` (fallback: `competitor_id`+`url` for legacy single-step rows), steps ordered by `funnel_step`. Each step returns `{ id, url, brand, status, funnel_step, page_type, skeleton, cta_target_url, captured_at, chapters: [{ index, label, signed_url }] }`. Signed URLs come from [[../libraries/landing-page-scout]] `signLanderShot` (1-hour TTL) against the private `lander-shots` bucket. `is_ours=true` rows are excluded — this surface is the competitor teardown view. Owner-only (403 for admin/member).

## Data source

- [[../tables/lander_snapshots]] — the captured per-chapter mobile snapshots (written by `scripts/landing-page-snapshot.ts`). `page_type` + `skeleton` come from [[../libraries/landing-page-scout]] `deconstructLander` (null until the vision pass has run on a step).
- [[../libraries/landing-page-scout]] `signLanderShot` — short-lived signed URLs into the private `lander-shots` bucket.

## Sidebar entry

Registered under the **Research** section in `src/app/dashboard/sidebar.tsx` (`ownerOnly: true`), sibling to Competitors.

## Related

[[../specs/funnel-teardown-scout]] · [[../libraries/landing-page-scout]] · [[../tables/lander_snapshots]] · [[marketing__acquisition]] · [[marketing__landers]].
