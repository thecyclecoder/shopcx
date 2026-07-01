# libraries/ltv

Canonical **lifetime-orders / LTV multipliers** — the single source of truth for the churn-derived subscription lifetime used across analytics. Extracted so the funnel-tree LTV/visit metric and the ROAS margin calculator can't drift.

**File:** `src/lib/ltv.ts` · Reads [[../tables/monthly_revenue_snapshots]] (`churn_pct`, `is_complete`). Read-only.

## The model
A subscriber's expected lifetime orders = **`1 / monthly_churn`** (geometric series — `1/churn` ≈ the number of monthly renewals before they cancel). A one-time buyer = `1`. The ROAS margin calculator's blended **"Avg lifetime orders"** (~3.5) is exactly `(1-subRate)·1 + subRate·(1/churn)` — the per-order average of those two. So a **sub specifically is worth `1/churn` (~4.5–5.3), not the blended 3.5.**

The multiplier is **not a constant** — it tracks real retention. Lower churn ⇒ a sub is worth more lifetime orders ⇒ LTV rises. This **couples Growth → Retention**: when [[retention]] lowers churn, every Growth destination's LTV/visit rises automatically. Always recompute it live.

## Exports
- **`subLifetimeOrders(monthlyChurn)`** → `1/churn` (a single sub's lifetime orders).
- **`blendedLifetimeOrders(subRate, monthlyChurn)`** → the ROAS card's blended "avg lifetime orders" (`subRate` is COUNT-based: subs ÷ total orders).
- **`getMonthlyChurn({ admin, workspaceId, trailingMonths? })`** → `ChurnBasis` `{ monthly_churn, sub_lifetime_orders, months_used, window }`. **Default `trailingMonths=6`** — a trailing window so the number stays RESPONSIVE to recent retention work. The ROAS margin calc uses **all-history** (stable but laggy — a recent retention win is diluted across every month); pass `trailingMonths: null` for that all-history parity. (Live data 2026-06: all-history churn 22.0% → ×4.54; trailing-6mo 18.9% → ×5.29 — the window choice materially moves the number.)

## Consumers
- [[funnel-tree]] `computeFunnelTree` — `revenue_per_visit_cents` + `ltv_per_visit_cents` per node (subs valued at `subLifetimeOrders`). Surfaces `ltvBasis` for auditability.
- (the ROAS margin calculator `dashboard/analytics/roas` still computes the same formula inline — a future cleanup is to route it through these helpers too.)

## Gotchas
- **Count-based vs revenue-share sub-rate.** The margin card's "Avg lifetime orders" uses the COUNT-based sub-rate (subs ÷ orders), NOT the revenue-share `sub_rate` field the ROAS API exposes. `blendedLifetimeOrders` expects the count-based one.
- **`orders.session_id` is sparse** — only storefront-checkout orders carry it (~the funnel order set). That's the correct set for funnel LTV attribution.
