# Dashboard · social-comments/banned

_TODO: page purpose._

**Route:** `/dashboard/social-comments/banned`

## Features

**Page title:** Banned users

**Visible buttons (heuristic — actual labels in source):**
- Unban

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/banned-meta-users`
- `/api/workspaces/:x/banned-meta-users/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/social-comments/banned/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
