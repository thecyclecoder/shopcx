# Settings · settings/workflows

Template workflow CRUD — order_tracking, cancel_request, subscription_inquiry, account_login, end_chat.

**Route:** `/dashboard/settings/workflows`

## Features

**Page title:** Workflows

**Visible buttons (heuristic — actual labels in source):**
- Configure
- Delete
- Set Up
- Cancel

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/members`
- `/api/workspaces/:x/workflows`
- `/api/workspaces/:x/workflows/:x`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/workflows/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
