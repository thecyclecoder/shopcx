# Dashboard · team

Workspace members list. Edit display_name + role per member. Invite flow.

**Route:** `/dashboard/team`

## Features

**Page title:** Team

**Visible buttons (heuristic — actual labels in source):**
- Cancel
- Remove

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/invite`
- `/api/workspaces/:x/members`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/team/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
