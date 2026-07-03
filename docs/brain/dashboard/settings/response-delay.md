# Settings · settings/response-delay

Per-channel outbound message delays (drives pending_send_at).

**Route:** `/dashboard/settings/response-delay`

## Features

**Page title:** Response Delay

**Visible buttons (heuristic — actual labels in source):**
- Save

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/response-delay/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
