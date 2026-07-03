# Settings · settings/ad-tool

_TODO: page purpose._

**Route:** `/dashboard/settings/ad-tool`

## Features

**Page title:** Ad tool

**Visible buttons (heuristic — actual labels in source):**
- Verify key

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/ad-tool-settings`
- `/api/workspaces/:x/gemini`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/ad-tool/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
