# Dashboard · comp-subscriptions

The comp **allowlist roster** — every `comp=true` subscription across the workspace: who gets free product, in what category, and what ships next. A comp sub ships on schedule for free ($0, no saved PM, no charge). Grouped by the customer's `comp_role` (Employees · Influencers · Investors · Owners). Read-only view (v1). See [[../specs/comp-subscriptions]].

**Route:** `/dashboard/comp-subscriptions`

## Features

**Page title:** Comp Subscriptions

- **Role group tabs:** All · Employees · Influencers · Investors · Owners, each with a live count (from `role_counts`).
- **Columns:** Customer (name + email) · Role (`comp_role` badge; `not allowlisted` in red when null) · Note (`subscriptions.comp_note` ?? `customers.comp_note`) · Products (items + quantities) · Cadence (`billing_interval` × count) · Next Ship (`next_billing_date`, sortable) · Status (sortable).
- **Search** by customer name/email. Row click → subscription detail (`/dashboard/subscriptions/[id]`).

**Rendering:** `"use client"` component (client-side state + fetch).

## API endpoints called

- `/api/workspaces/:x/comp-subscriptions` — every `comp=true` sub joined to its customer (`comp_role`, `comp_note`); supports `role`, `search`, `sort`, `order`; returns `{ subscriptions, total, role_counts }`.

## Permissions

Sidebar entry is `adminOnly` (owner/admin) — the comp roster is an internal free-product list. API gated by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/comp-subscriptions/page.tsx` — the page
- `src/app/api/workspaces/[id]/comp-subscriptions/route.ts` — the list API

## Related

[[../tables/subscriptions]] · [[../tables/customers]] · [[../lifecycles/subscription-billing]] · [[../libraries/migrate-to-internal]] · [[subscriptions]]

---

[[../README]] · [[../../CLAUDE]]
