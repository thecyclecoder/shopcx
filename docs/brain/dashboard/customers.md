# Dashboard · customers

Customer list with retention score, LTV, sub status, marketing consent, link group. Search + filters + bulk segment refresh.

**Route:** `/dashboard/customers`

## Features

**Page title:** Customers

**Visible buttons (heuristic — actual labels in source):**
- Start Over
- Sync Orders
- Dismiss
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[customers/[id]]]

## API endpoints called

- `/api/customers`
- `/api/workspaces/:x/sync`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/customers/page.tsx` — the page itself
- `src/app/dashboard/customers/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
