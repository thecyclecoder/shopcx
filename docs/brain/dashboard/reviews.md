# Dashboard · reviews

Product reviews dashboard. AI summaries, featured tagging, per-product breakdown.

⚠️ **Moderation is local-only and there is no Sync button.** Both changed in the Klaviyo sunset ([[../integrations/klaviyo]]): every approve/reject/feature used to PATCH Klaviyo, and the Sync button pulled from their `/reviews/` endpoint. Actions now write [[../tables/product_reviews]] directly and persist the moderator's `rejection_reason` + `rejection_explanation` (which previously lived only in Klaviyo). `/api/workspaces/:x/sync-reviews` returns `410 Gone`.

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
- `/api/workspaces/:x/sync-reviews` — **410 Gone** (retired)

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/reviews/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
