# Settings · settings/import

Data import wizard: Gorgias tickets, Klaviyo profiles, Shopify backfills.

**Route:** `/dashboard/settings/import`

## Features

**Page title:** Import Data

**Visible buttons (heuristic — actual labels in source):**
- Resume
- Dismiss

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/import/:x`
- `/api/workspaces/:x/import/subscriptions`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/import/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
