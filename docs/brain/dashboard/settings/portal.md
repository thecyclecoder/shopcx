# Settings · settings/portal

Customer portal config: branding, cancel reasons (shared with cancel-flow), enabled features.

**Route:** `/dashboard/settings/portal`

## Features

**Page title:** Customer Portal

**Visible buttons (heuristic — actual labels in source):**
- Copy

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/portal`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/portal/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
