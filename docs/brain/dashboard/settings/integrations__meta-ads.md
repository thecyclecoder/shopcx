# Settings · settings/integrations/meta-ads

_TODO: page purpose._

**Route:** `/dashboard/settings/integrations/meta-ads`

## Features

**Page title:** Meta Ads

**Visible buttons (heuristic — actual labels in source):**
- Cancel
- Last 7 days
- Last 30 days
- Last 90 days

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/meta-ads`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/integrations/meta-ads/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
