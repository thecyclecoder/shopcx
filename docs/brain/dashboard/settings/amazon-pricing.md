# Settings · settings/amazon-pricing

Amazon pricing strategy: raise prices N% to offset 25% Amazon fees and push buyers to the website.

**Route:** `/dashboard/settings/amazon-pricing`

## Features

**Page title:** Amazon Pricing

**Visible buttons (heuristic — actual labels in source):**
- Apply to all
- Clear all edits
- Clear sale
- Discard sale change

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/amazon/pricing`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/amazon-pricing/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
