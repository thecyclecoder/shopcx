# Dashboard · marketing/acquisition

The **Acquisition Research Hub** — one owner-only surface for the [[../goals/acquisition-research-engine|Acquisition Research Engine]] ([[../specs/acquisition-research-hub]], M4). Competitor sets + both scouts' findings + the unified gap queue → approve routes a gap to Build / the storefront optimizer, tracked through to shipped / won.

**Route:** `/dashboard/marketing/acquisition` · **owner-only** (nav item `ownerOnly`; the API returns 403 for non-owners).

## Features

**Page title:** Acquisition Research

**Rendering:** `"use client"` component (client-side state + fetch).

- **Throughput cards** — Proposed · Approved · Shipped · Won (the goal's success metric, [[../libraries/acquisition-hub]] `GapThroughput`).
- **Product selector** — scopes competitors + lander gaps/snapshots to a product (ad gaps are workspace-level, always shown).
- **Gap queue** — the unified ad + lander gap list with `source` / `route` / `status` / shipped / won badges; **Approve & route** / **Reject** on `proposed` gaps. Ad gaps POST `/api/ads/acquisition/gaps/[id]`; lander gaps POST the existing `/api/ads/lander-recommendations/[id]`.
- **Competitor set** ([[../tables/competitors]]), **Ad findings** (the [[../libraries/ad-gap]] report), **Lander findings** ([[../tables/lander_snapshots]]) panels.

## API endpoints called

- `GET /api/ads/acquisition?workspaceId=&productId=` → the whole hub payload ([[../libraries/acquisition-hub]] `loadHubData`).
- `POST /api/ads/acquisition/gaps/[id]` — approve/reject an ad gap (owner-only).
- `POST /api/ads/lander-recommendations/[id]` — approve/reject a lander gap (existing).

See [[../specs/acquisition-research-hub]] · [[../libraries/acquisition-hub]] · [[../tables/ad_gap_recommendations]] · [[marketing__landers]] · [[storefront__optimizer]].
