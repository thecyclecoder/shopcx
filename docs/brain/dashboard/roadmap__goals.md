# Dashboard · roadmap/goals

_TODO: page purpose._

**Route:** `/dashboard/roadmap/goals`

## Features

**Page title:** Goals

**Rendering:** Server component (no `use client` directive).

## Sub-routes

- `[slug]/` → [[roadmap/goals/[slug]]]

## API endpoints called

_None detected via static fetch() scan._

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/roadmap/goals/page.tsx` — the page itself
- `src/app/dashboard/roadmap/goals/[slug]/page.tsx` — sub-route
- `src/app/dashboard/roadmap/goals/GoalAccumulation.tsx` — component
- `src/app/dashboard/roadmap/goals/GoalStatusBadge.tsx` — component
- `src/app/dashboard/roadmap/goals/GreenlightButton.tsx` — component

---

[[../README]] · [[../../CLAUDE]]
