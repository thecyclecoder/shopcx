# Dashboard · chargebacks

Shopify dispute list with active sub count column. Filters: status (open/won/lost) + reason category. Slideout: account linking + auto-action history.

**Route:** `/dashboard/chargebacks`

## Features

**Page title:** Chargebacks

**Visible buttons (heuristic — actual labels in source):**
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/chargebacks`
- `/api/chargebacks/:x/cancel-subscription`
- `/api/chargebacks/:x/reinstate`
- `/api/chargebacks/:x/subscriptions`
- `/api/chargebacks/stats`
- `/api/customers/:x/links`
- `/api/customers/:x/suggestions`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/chargebacks/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
