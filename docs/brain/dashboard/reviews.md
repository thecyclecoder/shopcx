# Dashboard · reviews

Product reviews dashboard. Klaviyo-synced. AI summaries, featured tagging, per-product breakdown.

**Route:** `/dashboard/reviews`

## Features

**Page title:** Reviews

**Visible buttons (heuristic — actual labels in source):**
- Approve
- Reject
- Feature
- Unfeature
- Cancel
- Reject Review

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/products`
- `/api/workspaces/:x/reviews`
- `/api/workspaces/:x/reviews/:x`
- `/api/workspaces/:x/sync-reviews`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/reviews/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
