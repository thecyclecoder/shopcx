# Dashboard · resellers

Known resellers list (Amazon SP-API discoveries). Review queue for new entries before fraud rule activates.

**Route:** `/dashboard/resellers`

## Features

**Page title:** Known Resellers

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/resellers`
- `/api/workspaces/:x/resellers/:x`
- `/api/workspaces/:x/resellers/discover`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/resellers/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
