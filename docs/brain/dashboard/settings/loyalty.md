# Settings · settings/loyalty

Loyalty program config: tier structure, point earn rates, redemption tiers.

**Route:** `/dashboard/settings/loyalty`

## Features

**Page title:** Loyalty

**Visible buttons (heuristic — actual labels in source):**
- Add Tier
- Remove

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/loyalty`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/loyalty/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
