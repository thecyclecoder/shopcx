# Settings · settings/dunning

Dunning settings: enabled, max card rotations, payday retry toggle, cycle 1 + cycle 2 actions (skip/pause/cancel).

**Route:** `/dashboard/settings/dunning`

## Features

**Page title:** Recovery

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/dunning`
- `/api/workspaces/:x/dunning/error-codes`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/dunning/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
