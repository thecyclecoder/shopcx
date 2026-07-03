# Dashboard · brain

_TODO: page purpose._

**Route:** `/dashboard/brain`

## Features

**Page title:** Brain

**Rendering:** Server component (no `use client` directive).

## Sub-routes

- `[...slug]/` → [[brain/[...slug]]]

## API endpoints called

_None detected via static fetch() scan._

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/brain/page.tsx` — the page itself
- `src/app/dashboard/brain/[...slug]/page.tsx` — sub-route
- `src/app/dashboard/brain/BrainNav.tsx` — component
- `src/app/dashboard/brain/layout.tsx` — component
- `src/app/dashboard/brain/layout.tsx` — layout wrapper

---

[[../README]] · [[../../CLAUDE]]
