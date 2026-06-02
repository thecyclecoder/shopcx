# Settings · settings/knowledge-base

Help center configuration: slug, custom domain, logo, primary color. Scraper trigger.

**Route:** `/dashboard/settings/knowledge-base`

## Features

**Page title:** Knowledge Base

**Visible buttons (heuristic — actual labels in source):**
- Save

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`
- `/api/workspaces/:x/scrape-help-center`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/knowledge-base/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
