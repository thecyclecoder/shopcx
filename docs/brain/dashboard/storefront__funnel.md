# Dashboard · storefront/funnel

_TODO: page purpose._

**Route:** `/dashboard/storefront/funnel`

## Features

**Page title:** Storefront funnel

**Rendering:** `"use client"` component (client-side state + fetch).

**Running experiments panel:** surfaces active [[../tables/storefront_experiments]] (status `running`/`promoted`) with each arm's sessions / CVR / sub-attach and posterior **win-probability vs control** — computed in the funnel API route via [[../libraries/storefront-bandit]] `winProbabilityVsControl` and returned as `runningExperiments`. The supervisable surface for the bandit (storefront-experiment-bandit-framework Phase 4).

## Sub-routes

_None._

## API endpoints called

_None detected via static fetch() scan._

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/storefront/funnel/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
