# Dashboard · agents

_TODO: page purpose._

**Route:** `/dashboard/agents`

## Features

**Page title:** Agents

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[role]/` → [[agents/[role]]]
- `directors/` → [[agents/directors]]
- `org-chart/` → [[agents/org-chart]]
- `scorecard/` → [[agents/scorecard]]
- `workers/` → [[agents/workers]]

## API endpoints called

- `/api/developer/agents`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/agents/page.tsx` — the page itself
- `src/app/dashboard/agents/[role]/page.tsx` — sub-route
- `src/app/dashboard/agents/directors/page.tsx` — sub-route
- `src/app/dashboard/agents/org-chart/page.tsx` — sub-route
- `src/app/dashboard/agents/scorecard/page.tsx` — sub-route
- `src/app/dashboard/agents/workers/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
