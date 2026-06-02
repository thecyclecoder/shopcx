# Dashboard · replacements

Replacement orders list — originals + threshold tracking. Filters by reason / threshold-exceeded.

**Route:** `/dashboard/replacements`

## Features

**Page title:** Replacements

**Visible buttons (heuristic — actual labels in source):**
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[replacements/[id]]]

## API endpoints called

- `/api/workspaces/:x/replacements`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/replacements/page.tsx` — the page itself
- `src/app/dashboard/replacements/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
