# Dashboard · analytics/profit

The founder's profit read. **Closed months show QuickBooks actuals; the in-progress month shows a calibrated estimate.** The headline is **real profit** — net profit *before* management fees.

**Route:** `/dashboard/analytics/profit` · **Engine:** [[../libraries/profit-estimate]]

## Features

**Page title:** Profit

**Rendering:** `"use client"` component (client-side state + fetch). All arithmetic lives in [[../libraries/profit-estimate]] — the page renders, it does not compute.

### Headline row

| Tile | Line | Meaning |
|---|---|---|
| **Real profit** | `adjusted_net_income` | Net profit **before management fees** — the intercompany PR→TX transfer-pricing charge added back. The number to grow. |
| **Booked net profit** | `net_income` | As filed. Steered **≤ $0 per fiscal year** for US tax. |
| **Revenue** | `total_income` | QBO income (closed) or projected full month (estimate). |

A badge marks the source: **QuickBooks** (emerald) or **Estimate** (amber).

### P&L panel

Income → COGS → gross profit → digital advertising / transaction fees / fixed OpEx → net operating income → **real profit** (highlighted) → management fees → booked net profit.

### "How this estimate is built" panel

Only for the in-progress month. Shows the work rather than a black box:

- **Per-stream revenue projection** — renewals (`collected + scheduled book × collection rate`), new checkouts (run-rated), Amazon (run-rated), then `× incomeRatio` to reach QuickBooks income.
- **Cost factors** — COGS %, transaction-fee %, ad-spend multiplier, fixed OpEx, management fees, each labelled with the closed months it was calibrated from.
- **Flags** — missing snapshots, thin calibration, an empty renewal book.

For a closed month the panel just says every line is read straight from the month-end snapshot.

### Period picker

`This Month (estimate)` plus one entry per month that actually has a [[../tables/qb_pnl_snapshots]] row (`available_months` from the API) — so the picker can never offer a month with no data.

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/profit?period=this_month|last_month|YYYY-MM`

## Permissions

All workspace members. No role gate in the page itself; gated by middleware auth + workspace membership. (Note: the sibling CFO financials visual at `/dashboard/agents/cfo?s=financials` **is** owner/admin gated.)

## Files touched

- `src/app/dashboard/analytics/profit/page.tsx` — the page
- `src/app/api/workspaces/[id]/analytics/profit/route.ts` — period resolution + `available_months`
- `src/lib/profit-estimate.ts` — the engine ([[../libraries/profit-estimate]])

## History

Before 2026-08 the page computed profit client-side from six hardcoded constants and Meta-only ad spend, predating the QuickBooks integration. For July 2026 it reported **$46,065** against a real `adjusted_net_income` of **$65,458**, and it never modelled the management fee at all. See [[../libraries/profit-estimate]] § Why it exists.

## Related

[[../libraries/profit-estimate]] · [[../tables/qb_pnl_snapshots]] · [[analytics__mrr]] · [[../libraries/quickbooks]] · [[../functions/cfo]]

---

[[../README]] · [[../../CLAUDE]]
