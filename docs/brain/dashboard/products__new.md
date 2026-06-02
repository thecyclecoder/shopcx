# Dashboard · products/new

_TODO: page purpose._

**Route:** `/dashboard/products/new`

## Features

**Page title:** Add Product Intelligence

**Visible buttons (heuristic — actual labels in source):**
- Change
- Append to Intelligence

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/product-intelligence`
- `/api/workspaces/:x/product-intelligence/scrape-url`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/products/new/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
