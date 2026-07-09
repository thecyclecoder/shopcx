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
- `src/app/dashboard/roadmap/RunningTimer.tsx` — component (client-only island driving the spec-detail "Elapsed:" ticker)
- `src/app/dashboard/roadmap/StatusControl.tsx` — component
- `src/app/dashboard/roadmap/VerificationCard.tsx` — component
- `src/app/dashboard/roadmap/WaitTimer.tsx` — component (client-only island driving each open-wait's live duration on the spec-detail timeline)

## Spec-detail timecard timeline

The `[slug]/` sub-route ([[roadmap/[slug]]]) mounts `LifecycleTimeline` inside the detail card
sidebar. That timeline is the M5 surface of the Mario pipeline — beyond the 5-node lifecycle
row it also paints per-stage timing + open-wait rows off the timecard ledger:

- **Data source.** `getTimecard(admin, workspace_id, spec_slug)` from [[../libraries/spec-timecards]]
  returns the per-spec `TimecardView` (steps, open_waits, total_elapsed_ms, first_event_at,
  terminal_at). `readMarioThresholds(admin, workspace_id)` from [[../libraries/mario]] returns
  the workspace's `mario_thresholds` rows keyed by (from_event, to_event) → sla_ms. Both are
  loaded server-side in the [slug] page's `Promise.all` alongside the existing per-workspace
  readers, so no second server round-trip fires.
- **Color contract.** Inter-stage gap pills + open-wait rows follow the zinc/sky/amber/rose
  palette:
    - **zinc** (`text-zinc-400 dark:text-zinc-300`) — an inter-stage gap under SLA (or with no
      matching mario_thresholds row configured).
    - **sky** (`text-sky-500`) — a fresh open wait (under SLA or no threshold configured).
    - **amber** (`text-amber-500`) — a gap or wait past `sla_ms`.
    - **rose** (`text-rose-500`) — a gap or wait past `2 × sla_ms` (the M3 detector's
      double-SLA breach line).
- **Client hydration.** Only `WaitTimer.tsx` and `RunningTimer.tsx` carry a `"use client"`
  directive — every other subcomponent is server-rendered. The two islands share a
  `useEffect` + 1-second `setInterval` pattern to re-render the elapsed duration once per
  second; a folded spec renders a plain server-rendered `Total: <static duration>` instead of
  mounting `RunningTimer`, so no client tick fires on a terminal spec.

---

[[../README]] · [[../../CLAUDE]]
