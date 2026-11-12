# Dashboard · analytics/revenue

_TODO: page purpose._

**Route:** `/dashboard/analytics/revenue`

## Features

**Page title:** Revenue Analytics

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/revenue`

## Permissions

**Workspace owner only** (`workspace_members.role='owner'` → 403 otherwise). The GET `/api/workspaces/:x/analytics/revenue` route gates on owner membership before serving financial data. This is the template gate for analytics routes with sensitive financial information.

## Files touched

- `src/app/dashboard/analytics/revenue/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
