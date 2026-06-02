# Dashboard · social-comments/analysis

_TODO: page purpose._

**Route:** `/dashboard/social-comments/analysis`

## Features

**Page title:** AI moderation analyzer

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/social-comments`
- `/api/workspaces/:x/social-comments/:x/rate`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/social-comments/analysis/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
