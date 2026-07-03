# Dashboard · macros

Macro library with acceptance rate badges. Inline editor, AI-suggestion counters, usage chart per macro.

**Route:** `/dashboard/macros`

## Features

**Page title:** Macros

**Visible buttons (heuristic — actual labels in source):**
- New Macro
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[macros/[id]]]

## API endpoints called

- `/api/workspaces/:x/macros`
- `/api/workspaces/:x/macros/:x`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/macros/page.tsx` — the page itself
- `src/app/dashboard/macros/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
