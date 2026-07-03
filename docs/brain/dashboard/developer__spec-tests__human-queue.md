# Dashboard · developer/spec-tests/human-queue

_TODO: page purpose._

**Route:** `/dashboard/developer/spec-tests/human-queue`

## Features

**Page title:** Human-test queue

**Visible buttons (heuristic — actual labels in source):**
- Dismiss
- Re-open

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/developer/spec-test/human-queue`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/developer/spec-tests/human-queue/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
