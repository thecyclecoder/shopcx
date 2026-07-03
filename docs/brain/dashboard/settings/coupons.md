# Settings · settings/coupons

Coupon mappings — Shopify code ↔ internal mapping with VIP tier filtering.

**Route:** `/dashboard/settings/coupons`

## Features

**Page title:** Coupons

**Filters:**
- use_case: { value: discount_request, label: Discount Request },
  { value: fixing_mistake, label: Fixing a Mistake },
  { value: retention_save, label: Retention / Save },
  { value: win_back, label: Win-Back },
  { value: first_order, label: First Order Incentive },
  { value: subscription_incentive, label: Subscription Incentive },
  { value: apology, label: Apology / Service Recovery },
- tier: { value: all, label: All Customers },
  { value: vip, label: VIP Only },
  { value: non_vip, label: Non-VIP Only },

**Visible buttons (heuristic — actual labels in source):**
- Save
- Map Coupon
- Remove
- Change
- Cancel

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/coupons`
- `/api/workspaces/:x/coupons${sync `
- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/coupons/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
