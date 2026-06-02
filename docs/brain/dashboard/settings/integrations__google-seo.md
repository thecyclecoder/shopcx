# Settings · settings/integrations/google-seo

_TODO: page purpose._

**Route:** `/dashboard/settings/integrations/google-seo`

## Features

**Page title:** Google SEO Tools

**Visible buttons (heuristic — actual labels in source):**
- Save Settings

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/integrations/google-seo/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
