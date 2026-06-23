# Dashboard · (home)

Dashboard home — workspace overview, KPI cards (open tickets, customers, retention, AI resolution rate).

**Route:** `/dashboard`

## Features

**Page title:** Overview

**Visible buttons (heuristic — actual labels in source):**
- Dismiss

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `ai-analysis/` → [[ai-analysis]]
- `chargebacks/` → [[chargebacks]]
- `conversations/` → [[conversations]]
- `crisis/` → [[crisis]]
- `csat/` → [[csat]]
- `customers/` → [[customers]]
- `demographics/` → [[demographics]]
- `fraud/` → [[fraud]]
- `knowledge-base/` → [[knowledge-base]]
- `loyalty/` → [[loyalty]]
- `macros/` → [[macros]]
- `orders/` → [[orders]]
- `portal-analytics/` → [[portal-analytics]]
- `products/` → [[products]]
- `replacements/` → [[replacements]]
- `resellers/` → [[resellers]]
- `returns/` → [[returns]]
- `reviews/` → [[reviews]]
- `settings/` → [[settings]]
- `social-comments/` → [[social-comments]]
- `subscriptions/` → [[subscriptions]]
- `team/` → [[team]]
- `tickets/` → [[tickets]]

## API endpoints called

- `/api/tickets`
- `/api/workspaces/:x/dashboard-stats`
- `/api/workspaces/:x/notifications`
- `/api/workspaces/:x/notifications/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/page.tsx` — the page itself
- `src/app/dashboard/ai-analysis/page.tsx` — sub-route
- `src/app/dashboard/chargebacks/page.tsx` — sub-route
- `src/app/dashboard/conversations/page.tsx` — sub-route
- `src/app/dashboard/crisis/page.tsx` — sub-route
- `src/app/dashboard/csat/page.tsx` — sub-route
- `src/app/dashboard/customers/page.tsx` — sub-route
- `src/app/dashboard/demographics/page.tsx` — sub-route
- `src/app/dashboard/fraud/page.tsx` — sub-route
- `src/app/dashboard/knowledge-base/page.tsx` — sub-route
- `src/app/dashboard/loyalty/page.tsx` — sub-route
- `src/app/dashboard/macros/page.tsx` — sub-route
- `src/app/dashboard/orders/page.tsx` — sub-route
- `src/app/dashboard/portal-analytics/page.tsx` — sub-route
- `src/app/dashboard/products/page.tsx` — sub-route
- `src/app/dashboard/replacements/page.tsx` — sub-route
- `src/app/dashboard/resellers/page.tsx` — sub-route
- `src/app/dashboard/returns/page.tsx` — sub-route
- `src/app/dashboard/reviews/page.tsx` — sub-route
- `src/app/dashboard/settings/page.tsx` — sub-route
- `src/app/dashboard/social-comments/page.tsx` — sub-route
- `src/app/dashboard/subscriptions/page.tsx` — sub-route
- `src/app/dashboard/team/page.tsx` — sub-route
- `src/app/dashboard/tickets/page.tsx` — sub-route
- `src/app/dashboard/layout.tsx` — component
- `src/app/dashboard/sidebar.tsx` — component. Mounted for **every** user on **every** dashboard page; its `fetchCounts` effect issues ~11 authenticated API requests per tick (ticket-views, escalation counts, fraud-cases, reviews, todos, improve-queue, branches, spec-test human-queue, …). It polls at **30 000 ms** (`setInterval(fetchCounts, 30000)`), **not** 10s — badge counts tolerate 30s staleness, and the always-on, authenticated REST rate is the dominant source of PostgREST's per-request RLS-context `set_config` statement (the highest-call-volume query in `pg_stat_statements`). Widening it 10s→30s cut that always-on round-trip rate ~3× — the canonical shipped [[../libraries/db-health|DB Health Agent]] `high_call_volume → reduce_calls` fix. Don't tighten this poll without a reason.
- `src/app/dashboard/layout.tsx` — layout wrapper

## Related

[[../README]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/dunning]] · [[../lifecycles/subscription-billing]]

---

[[../README]] · [[../../CLAUDE]]
