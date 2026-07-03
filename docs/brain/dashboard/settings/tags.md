# Settings · settings/tags

Tag management — create / rename / merge / delete tags across tickets + customers.

**Route:** `/dashboard/settings/tags`

## Features

**Page title:** Tags

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/tags`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/tags/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
