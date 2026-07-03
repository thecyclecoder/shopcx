# Dashboard · loyalty

Loyalty members + redemptions dashboard. Tier breakdown, top earners, redemption history.

**Route:** `/dashboard/loyalty`

## Features

**Page title:** Loyalty

**Visible buttons (heuristic — actual labels in source):**
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[memberId]/` → [[loyalty/[memberId]]]

## API endpoints called

- `/api/loyalty/members`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/loyalty/page.tsx` — the page itself
- `src/app/dashboard/loyalty/[memberId]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
