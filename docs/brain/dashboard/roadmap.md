# Dashboard · roadmap

_TODO: page purpose._

**Route:** `/dashboard/roadmap`

## Features

**Page title:** Pipeline

**Rendering:** Server component (no `use client` directive).

## Sub-routes

- `[slug]/` → [[roadmap/[slug]]]
- `box/` → [[roadmap/box]]
- `goals/` → [[roadmap/goals]]
- `map/` → [[roadmap/map]]

## API endpoints called

_None detected via static fetch() scan._

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/roadmap/page.tsx` — the page itself
- `src/app/dashboard/roadmap/[slug]/page.tsx` — sub-route
- `src/app/dashboard/roadmap/box/page.tsx` — sub-route
- `src/app/dashboard/roadmap/goals/page.tsx` — sub-route
- `src/app/dashboard/roadmap/map/page.tsx` — sub-route
- `src/app/dashboard/roadmap/AuthoringChat.tsx` — component
- `src/app/dashboard/roadmap/BoxChip.tsx` — component
- `src/app/dashboard/roadmap/BranchPosition.tsx` — component
- `src/app/dashboard/roadmap/BuildButton.tsx` — component
- `src/app/dashboard/roadmap/LifecycleControls.tsx` — component
- `src/app/dashboard/roadmap/LifecycleTimeline.tsx` — component
- `src/app/dashboard/roadmap/PhaseList.tsx` — component
- `src/app/dashboard/roadmap/PlanButton.tsx` — component
- `src/app/dashboard/roadmap/PriorityControl.tsx` — component
- `src/app/dashboard/roadmap/RoadmapFilters.tsx` — component
- `src/app/dashboard/roadmap/StatusControl.tsx` — component
- `src/app/dashboard/roadmap/VerificationCard.tsx` — component

---

[[../README]] · [[../../CLAUDE]]
