# Settings · settings/cancel-flow

Cancel reasons (slug, label, type=remedy/ai_conversation, enabled, sort_order) + Remedies CRUD (type, config). Drives the cancel journey.

**Route:** `/dashboard/settings/cancel-flow`

## Features

**Page title:** Cancel Flow

**Visible buttons (heuristic — actual labels in source):**
- Add Reason
- Edit
- Delete
- Seed defaults
- Save
- Cancel
- Add Remedy

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/cancel-flow`
- `/api/workspaces/:x/cancel-flow/remedies`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/cancel-flow/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
