# Dashboard · developer/control-tower

_TODO: page purpose._

**Route:** `/dashboard/developer/control-tower`

## Features

**Page title:** Coverage self-audit

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/developer/control-tower`
- `/api/developer/control-tower/coverage-register`
- `/api/developer/control-tower/db-health`
- `/api/developer/control-tower/repair`
- `/api/roadmap/spec-drift`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/developer/control-tower/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
