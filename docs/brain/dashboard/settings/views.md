# Settings · settings/views

Ticket view CRUD with nested hierarchy (2 levels deep).

**Route:** `/dashboard/settings/views`

## Features

**Page title:** Ticket Views

**Visible buttons (heuristic — actual labels in source):**
- Edit
- Delete
- New View
- Cancel

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/members`
- `/api/workspaces/:x/tags`
- `/api/workspaces/:x/ticket-views`
- `/api/workspaces/:x/ticket-views/:x`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/views/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
