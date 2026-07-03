# Dashboard · branches

_TODO: page purpose._

**Route:** `/dashboard/branches`

## Features

**Page title:** Branches

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/branches`
- `/api/branches/:x/merge`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/branches/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
