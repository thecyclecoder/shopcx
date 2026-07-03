# Dashboard · developer/approvals

_TODO: page purpose._

**Route:** `/dashboard/developer/approvals`

## Features

**Page title:** Approvals

**Visible buttons (heuristic — actual labels in source):**
- Refresh

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/developer/agents/inbox/dismiss`
- `/api/developer/approvals`
- `/api/roadmap/approve`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/developer/approvals/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
