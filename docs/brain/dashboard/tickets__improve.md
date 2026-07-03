# Dashboard · tickets/improve

_TODO: page purpose._

**Route:** `/dashboard/tickets/improve`

## Features

**Page title:** Earlier

**Visible buttons (heuristic — actual labels in source):**
- Mark read

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/tickets/improve-queue`
- `/api/tickets/improve-queue/seen`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/tickets/improve/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
