# Dashboard · marketing/social

_TODO: page purpose._

**Route:** `/dashboard/marketing/social`

## Features

**Page title:** Social Publisher

**Visible buttons (heuristic — actual labels in source):**
- Save
- Cancel
- Edit
- Approve
- Post now
- Plan next 7 days
- Add promo

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/social`
- `/api/workspaces/:x/social/posts/:x`
- `/api/workspaces/:x/social/promos`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/social/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
