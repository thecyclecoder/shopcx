# Settings · settings/auto-close

Auto-close reply template + per-channel timing.

**Route:** `/dashboard/settings/auto-close`

## Features

**Page title:** Auto-Close Reply

**Visible buttons (heuristic — actual labels in source):**
- Save

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/auto-close/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
