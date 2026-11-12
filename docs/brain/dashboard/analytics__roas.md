# Dashboard · analytics/roas

The Growth/Finance ROAS surface: checkout revenue ÷ ad spend (excludes recurring), with LTV, CAC, LTV:CAC, and a **Margin Calculator** that models first-order and lifetime profit per customer per channel.

**Route:** `/dashboard/analytics/roas`

## Features

**Page title:** ROAS

**Rendering:** `"use client"` component (client-side state + fetch).

- **Summary + LTV cards** — ROAS, revenue, per-channel revenue, sub rates, blended/website/amazon LTV, renewal-derived predicted sub-LTV, CAC, LTV:CAC.
- **Margin Calculator** (`MarginCalculator`) — per-channel (Website · Amazon · Blended order-weighted mix) first-order profit, lifetime orders/revenue/profit, true ROAS, and breakeven max CAC, plus a spend-scaling table (ROAS-decay model).
  - **Cost rates come from the closed QuickBooks books, not typed-in guesses.** The route serves `cost_rates` from [[../libraries/closed-book-cost-rates]] `getClosedBookCostRates` (trailing 3 closed months). Website carries COGS + Amplifier fulfillment + Shopify/PayPal/Braintree tx fees; Amazon carries COGS + FBA + seller fees. The calculator has **no editable cost inputs** — a caption shows the source months ("Cost rates from closed books: Jul–Sep 2026").
  - **No Discounts line** — ROAS revenue is `orders.total_cents` (daily-order-snapshot), already net of discounts, so a discount deduction would double-count.
  - **`cost_rates` null** (no closed month snapshotted yet) → the calculator shows a short "rates unavailable" note instead of falling back to guesses.
  - **Blended** stays the order-weighted channel mix; **ad cost (CAC) is charged once** on the first order, not per lifetime order.

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:id/analytics/roas` — returns `daily`, `totals`, `summary`, `storefrontSubLtv`, and `cost_rates` (the closed-book per-channel variable cost rates). See [[../libraries/closed-book-cost-rates]].

## Permissions

**Workspace owner only** (`workspace_members.role='owner'` → 403 otherwise). The GET `/api/workspaces/:id/analytics/roas` route gates on owner membership before computing or returning closed-book cost_rates (and all other tenant financial data). The gate runs immediately after auth + admin client creation and before any daily_order_snapshots/orders query, so unauthorized callers receive no tenant data. Mirrors the financial-data gate on analytics/revenue/route.ts.

## Files touched

- `src/app/dashboard/analytics/roas/page.tsx` — the page + `MarginCalculator`
- `src/app/api/workspaces/[id]/analytics/roas/route.ts` — the data route (calls `getClosedBookCostRates`)

## Related

[[../libraries/closed-book-cost-rates]] · [[../tables/qb_pnl_snapshots]] · [[../libraries/ltv]] · [[../libraries/order-bucketing]] · [[../functions/cfo]]

---

[[../README]] · [[../../CLAUDE]]
