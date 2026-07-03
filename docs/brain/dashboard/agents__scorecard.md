# Dashboard · agents/scorecard

_TODO: page purpose._

**Route:** `/dashboard/agents/scorecard`

## Features

**Page title:** Platform scorecard

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/developer/agents/scorecard`
- `/api/developer/agents/scorecard/audit`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/agents/scorecard/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
