# Dashboard · marketing/ads

The ad-studio landing. Split layout: **Avatars** · **New ad** · **Library** (grid of completed [[../tables/ad_videos]]). Entry point for the [[../lifecycles/ad-render|ad-render lifecycle]] — click into the builder to generate, or into Avatars to manage spokespersons.

**Route:** `/dashboard/marketing/ads`

## Features

**Page title:** Ads

**Visible buttons (heuristic — actual labels in source):**
- New ad → `/dashboard/marketing/ads/new`
- Avatars → `/dashboard/marketing/ads/avatars`
- (per-ad card) → `/dashboard/marketing/ads/[id]`

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `new/` → [[marketing__ads__new]]
- `avatars/` → [[marketing__ads__avatars]]
- `[id]/` → per-ad detail (video + static previews, download buttons, sibling-cut links)
- `angles/[productId]/` → angle library for a product (generate fresh angles)

## API endpoints called

- `GET /api/ads/campaigns` — campaign + ad list for the library grid

## Permissions

Owner / admin. Other roles can view but the create/manage surfaces are gated. Gated by middleware auth + workspace membership; the ad tool is only reachable when `workspaces.ad_tool_enabled=true`.

## Files touched

- `src/app/dashboard/marketing/ads/page.tsx` — the landing page
- `src/app/dashboard/marketing/ads/[id]/page.tsx` — per-ad detail
- `src/app/dashboard/marketing/ads/angles/[productId]/page.tsx` — angle library

## Related

[[../lifecycles/ad-render]] · [[../tables/ad_videos]] · [[../tables/ad_campaigns]] · [[marketing__ads__new]] · [[marketing__ads__avatars]]

---

[[../README]] · [[../../CLAUDE]]
