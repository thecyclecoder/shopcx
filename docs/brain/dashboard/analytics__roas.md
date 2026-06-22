# Dashboard · analytics/roas

_TODO: page purpose._

**Route:** `/dashboard/analytics/roas`

## Features

**Page title:** ROAS

**Rendering:** `"use client"` component (client-side state + fetch).

**Predicted sub-LTV card:** the ROAS LTV cards are AOV×churn-derived; this card surfaces the storefront optimizer's **renewal-survival-derived est-sub-LTV** ([[../tables/storefront_ltv_metrics]] `est_sub_ltv_cents`, the metric the dashboard previously lacked). The API route's `buildStorefrontSubLtv` returns `storefrontSubLtv` — the newest snapshot per product, blended by sub-conversions, with `weights_version` + `calibrated`. Wired in storefront-ltv-proxy-reconciler Phase 4.

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/roas`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/roas/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
