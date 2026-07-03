# Settings · settings/chat-widget

Chat widget config: enabled, color, greeting, position, path mappings.

**Route:** `/dashboard/settings/chat-widget`

## Features

**Page title:** Live Chat Widget

**Visible buttons (heuristic — actual labels in source):**
- Remove from Shopify
- Remove

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/widget-install`
- `/api/workspaces/:x/widget-path-mappings`
- `/api/workspaces/:x/widget-settings`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/chat-widget/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
