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
- `src/app/dashboard/workspace-switcher.tsx` — workspace switcher (sidebar name block → dropdown)
- `src/app/dashboard/layout.tsx` — layout wrapper
- `src/app/api/dashboard/sidebar-counts/route.ts` — consolidated sidebar badge-count endpoint ([[sidebar-counts]])

## Status / open work

**Workspace switcher (2026-11-12):** The sidebar's workspace name block is now a `WorkspaceSwitcher` client component (`src/app/dashboard/workspace-switcher.tsx`), fed `workspaces = getUserWorkspaces(user.id)` from `layout.tsx` (passed to `Sidebar` as a new `workspaces` prop). With one workspace it renders exactly as the old static name + role block; with more than one it becomes a button opening a small zinc/indigo menu (styled like `src/app/workspace/select/workspace-list.tsx`) listing every workspace the user belongs to with its role, the current one checked. Selecting one calls the existing `selectWorkspace(id)` server action ([[../../../src/app/workspace/select/actions.ts]] → `setActiveWorkspace`), then `router.push('/dashboard')` + `router.refresh()`. A 'Create workspace' link to `/workspace/new` sits at the bottom of the menu. Shared `sidebarContent` means it works in the mobile drawer too. The tickets-only landing fallback for workspaces lacking the dashboard feature is deferred until the [[../goals/shopgrowth-software-support]] M1 "Workspace feature access" milestone exposes a per-workspace dashboard flag. See [[../libraries/workspace]].

**Performance tuning:** The always-on sidebar's `fetchCounts()` poll interval was widened 30s→60s (2026-07-04, spec `db-reduce-calls-q-7726440967385220442`) to cut authenticated RLS `set_config(...)` call volume — a follow-on to the prior 10s→30s widen targeting the same high-frequency round-trip family. Both changes reduce the dominant authenticated load source without materially hurting responsiveness (badge counts tolerate 60s staleness). Phase 3 consolidation ([[../specs/db-load-cut-getspec-amplifier-claim-fan-sidebar-spray]]) further collapsed the 13-17 per-badge endpoint fetches into ONE authenticated round-trip via the [[sidebar-counts]] endpoint.

---

[[../README]] · [[../../CLAUDE]]
