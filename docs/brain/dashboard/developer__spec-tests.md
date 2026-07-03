# Dashboard · developer/spec-tests

_TODO: page purpose._

**Route:** `/dashboard/developer/spec-tests`

## Features

**Page title:** Spec Tests

**Rendering:** Server component (no `use client` directive).

## Sub-routes

- `human-queue/` → [[developer/spec-tests/human-queue]]

## API endpoints called

_None detected via static fetch() scan._

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/developer/spec-tests/page.tsx` — the page itself
- `src/app/dashboard/developer/spec-tests/human-queue/page.tsx` — sub-route
- `src/app/dashboard/developer/spec-tests/FixCard.tsx` — component
- `src/app/dashboard/developer/spec-tests/ProposeFixButton.tsx` — component
- `src/app/dashboard/developer/spec-tests/SpecTestView.tsx` — component
- `src/app/dashboard/developer/spec-tests/TestNowButton.tsx` — component
- `src/app/dashboard/developer/spec-tests/shared.tsx` — component

---

[[../README]] · [[../../CLAUDE]]
