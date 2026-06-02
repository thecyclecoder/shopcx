# Settings · settings/pricing-rules

Storefront pricing rules — tier qty + mode + frequency + discount%.

**Route:** `/dashboard/settings/pricing-rules`

## Features

**Page title:** Pricing Rules

**Visible buttons (heuristic — actual labels in source):**
- Delete

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/pricing-rules`
- `/api/workspaces/:x/pricing-rules/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/pricing-rules/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
