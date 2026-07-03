# Settings · settings/subscription-settings

Subscription default discount %, frequencies, free shipping threshold, free gift variant.

**Route:** `/dashboard/settings/subscription-settings`

## Features

**Page title:** Subscription Settings

**Visible buttons (heuristic — actual labels in source):**
- Add

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/subscription-settings`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/subscription-settings/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
