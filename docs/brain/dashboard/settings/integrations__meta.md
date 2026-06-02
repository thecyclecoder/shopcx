# Settings · settings/integrations/meta

_TODO: page purpose._

**Route:** `/dashboard/settings/integrations/meta`

## Features

**Page title:** Meta pages

**Visible buttons (heuristic — actual labels in source):**
- Connect a page
- Connect your first page
- Add
- Disconnect

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/meta/auth`
- `/api/workspaces/:x/meta-ad-accounts`
- `/api/workspaces/:x/meta-pages`
- `/api/workspaces/:x/meta-pages/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/integrations/meta/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
