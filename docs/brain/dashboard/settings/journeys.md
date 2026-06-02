# Settings · settings/journeys

Journey definitions list + per-journey detail. Edit channels, match_patterns, trigger_intent, step_ticket_status, priority. Flow visualization.

**Route:** `/dashboard/settings/journeys`

## Features

**Page title:** Journeys

**Visible buttons (heuristic — actual labels in source):**
- Delete Journey
- Edit
- Apply
- Cancel

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/journeys`
- `/api/workspaces/:x/journeys/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/journeys/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
