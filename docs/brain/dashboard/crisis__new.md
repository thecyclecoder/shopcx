# Dashboard · crisis/new

Create a crisis campaign — pick affected variant, configure default swap + Tier 1/2/3 options + coupon.

**Route:** `/dashboard/crisis/new`

## Features

**Page title:** New Crisis Event

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/crisis`
- `/api/workspaces/:x/crisis/coupon-lookup`
- `/api/workspaces/:x/products`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/crisis/new/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
