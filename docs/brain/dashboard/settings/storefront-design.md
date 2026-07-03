# Settings · settings/storefront-design

Storefront branding: font, primary color, accent, logo, favicon.

**Route:** `/dashboard/settings/storefront-design`

## Features

**Page title:** Storefront Design

**Visible buttons (heuristic — actual labels in source):**
- Remove logo
- Remove favicon
- Primary button
- Reset

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/storefront-design`
- `/api/workspaces/:x/storefront-design/favicon`
- `/api/workspaces/:x/storefront-design/logo`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/storefront-design/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
