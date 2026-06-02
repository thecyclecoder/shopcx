# Dashboard · knowledge-base

Help center article CRUD. Rich text editor (contentEditable + toolbar). Slug, published toggle, product mapping. Help center scraper trigger.

**Route:** `/dashboard/knowledge-base`

## Features

**Page title:** Articles

**Visible buttons (heuristic — actual labels in source):**
- New Article
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[knowledge-base/[id]]]

## API endpoints called

- `/api/workspaces/:x/integrations`
- `/api/workspaces/:x/knowledge-base`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/knowledge-base/page.tsx` — the page itself
- `src/app/dashboard/knowledge-base/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
