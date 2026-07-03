# Dashboard · fraud

Fraud cases list. Filters by status (open/reviewing/confirmed_fraud/dismissed) + rule type + severity. Detail view shows held orders, linked customers, rule evidence.

**Route:** `/dashboard/fraud`

## Features

**Page title:** Fraud Monitor

**Visible buttons (heuristic — actual labels in source):**
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[fraud/[id]]]

## API endpoints called

- `/api/workspaces/:x/fraud-cases`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/fraud/page.tsx` — the page itself
- `src/app/dashboard/fraud/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
