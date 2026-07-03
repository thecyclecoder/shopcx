# Dashboard · (home)

Dashboard home — workspace overview, KPI cards (open tickets, customers, retention, AI resolution rate).

**Route:** `/dashboard`

## Features

**Page title:** Overview

**Visible buttons (heuristic — actual labels in source):**
- Dismiss

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `agents/` → [[agents]]
- `ai-analysis/` → [[ai-analysis]]
- `brain/` → [[brain]]
- `branches/` → [[branches]]
- `chargebacks/` → [[chargebacks]]
- `comp-subscriptions/` → [[comp-subscriptions]]
- `conversations/` → [[conversations]]
- `crisis/` → [[crisis]]
- `csat/` → [[csat]]
- `customers/` → [[customers]]
- `demographics/` → [[demographics]]
- `developer/` → [[developer]]
- `fraud/` → [[fraud]]
- `knowledge-base/` → [[knowledge-base]]
- `loyalty/` → [[loyalty]]
- `macros/` → [[macros]]
- `migrations/` → [[migrations]]
- `orders/` → [[orders]]
- `portal-analytics/` → [[portal-analytics]]
- `products/` → [[products]]
- `replacements/` → [[replacements]]
- `resellers/` → [[resellers]]
- `returns/` → [[returns]]
- `reviews/` → [[reviews]]
- `roadmap/` → [[roadmap]]
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
- `src/app/dashboard/agents/page.tsx` — sub-route
- `src/app/dashboard/ai-analysis/page.tsx` — sub-route
- `src/app/dashboard/brain/page.tsx` — sub-route
- `src/app/dashboard/branches/page.tsx` — sub-route
- `src/app/dashboard/chargebacks/page.tsx` — sub-route
- `src/app/dashboard/comp-subscriptions/page.tsx` — sub-route
- `src/app/dashboard/conversations/page.tsx` — sub-route
- `src/app/dashboard/crisis/page.tsx` — sub-route
- `src/app/dashboard/csat/page.tsx` — sub-route
- `src/app/dashboard/customers/page.tsx` — sub-route
- `src/app/dashboard/demographics/page.tsx` — sub-route
- `src/app/dashboard/developer/page.tsx` — sub-route
- `src/app/dashboard/fraud/page.tsx` — sub-route
- `src/app/dashboard/knowledge-base/page.tsx` — sub-route
- `src/app/dashboard/loyalty/page.tsx` — sub-route
- `src/app/dashboard/macros/page.tsx` — sub-route
- `src/app/dashboard/migrations/page.tsx` — sub-route
- `src/app/dashboard/orders/page.tsx` — sub-route
- `src/app/dashboard/portal-analytics/page.tsx` — sub-route
- `src/app/dashboard/products/page.tsx` — sub-route
- `src/app/dashboard/replacements/page.tsx` — sub-route
- `src/app/dashboard/resellers/page.tsx` — sub-route
- `src/app/dashboard/returns/page.tsx` — sub-route
- `src/app/dashboard/reviews/page.tsx` — sub-route
- `src/app/dashboard/roadmap/page.tsx` — sub-route
- `src/app/dashboard/settings/page.tsx` — sub-route
- `src/app/dashboard/social-comments/page.tsx` — sub-route
- `src/app/dashboard/subscriptions/page.tsx` — sub-route
- `src/app/dashboard/team/page.tsx` — sub-route
- `src/app/dashboard/tickets/page.tsx` — sub-route
- `src/app/dashboard/layout.tsx` — component
- `src/app/dashboard/sidebar.tsx` — component
- `src/app/dashboard/layout.tsx` — layout wrapper

---

[[../README]] · [[../../CLAUDE]]
