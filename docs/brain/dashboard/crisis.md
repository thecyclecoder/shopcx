# Dashboard · crisis

Crisis campaign list. Each: affected variant, active customers, per-tier response stats. Detail page for activation + resolve.

**Route:** `/dashboard/crisis`

## Features

**Page title:** Crisis Management

**Visible buttons (heuristic — actual labels in source):**
- New Crisis

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[crisis/[id]]]
- `new/` → [[crisis/new]]

## API endpoints called

- `/api/workspaces/:x/crisis`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/crisis/page.tsx` — the page itself
- `src/app/dashboard/crisis/[id]/page.tsx` — sub-route
- `src/app/dashboard/crisis/new/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
