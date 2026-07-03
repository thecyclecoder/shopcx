# Dashboard · agents/workers

_TODO: page purpose._

**Route:** `/dashboard/agents/workers`

## Features

**Page title:** Agents

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/developer/agents`
- `/api/developer/agents/rollups`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/agents/workers/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
