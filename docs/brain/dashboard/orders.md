# Dashboard · orders

Order list with filters. Detail view shows line items, fulfillments, transactions, attribution, and — for a storefront/`SHOPCX` order whose session resolves — a **Journey panel**.

**Route:** `/dashboard/orders`

## Features

**Page title:** Orders

**Visible buttons (heuristic — actual labels in source):**
- Search
- Clear
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

**Journey panel (detail view):** on a storefront/`SHOPCX` order, joins `orders.session_id` → the [[../tables/storefront_sessions|session]] + its `storefront_events` timeline — **source** (lander + `?variant=`, UTM/ad), **experiment + arm** (from the session's `experiment_assignments` stamp), and the **funnel** (landing → pdp_view → engaged → add_to_cart → checkout → order_placed, with timestamps). A synced Shopify order with no `session_id` shows no panel. Full trace: [[../lifecycles/storefront-session-attribution]].

## Sub-routes

- `[id]/` → [[orders/[id]]]

## API endpoints called

- `/api/workspaces/:x/orders`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/orders/page.tsx` — the page itself
- `src/app/dashboard/orders/[id]/page.tsx` — sub-route

## Related

[[../tables/orders]] · [[../tables/transactions]] · [[../integrations/shopify]] · [[../lifecycles/storefront-session-attribution]]

---

[[../README]] · [[../../CLAUDE]]
