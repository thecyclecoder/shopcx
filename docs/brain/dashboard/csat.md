# Dashboard · csat

CSAT survey dashboard. Resolution-gate stats (did we resolve?), rating distribution, comment list. Per-channel + per-agent breakdowns.

**Route:** `/dashboard/csat`

## Features

**Page title:** CSAT

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `GET /api/workspaces/:x/csat` — stats + recent responses. Stats aggregates drop `excluded_at IS NOT NULL` rows; the list still includes them (carrying `excluded_at` + `exclusion_reason`) so the owner can see + reverse.
- `POST /api/workspaces/:x/csat` with `action:'exclude'` (owner-only, body: `{ csat_id, reason }`) sets `excluded_at=now`, `excluded_by=user.id`, `exclusion_reason`.
- `POST /api/workspaces/:x/csat` with `action:'include'` (owner-only, body: `{ csat_id }`) clears all three columns.
- `POST /api/workspaces/:x/csat` with `action:'create_ticket'` (owner/admin/agent) — unchanged.

## Permissions

All workspace members can view. The **Exclude from stats / Include** control on each CSAT row is OWNER-only — non-owners never see the button, and a direct `POST action:'exclude'` returns 403. See [[../tables/ticket_csat]] `excluded_at` / `excluded_by` / `exclusion_reason`.

## Files touched

- `src/app/dashboard/csat/page.tsx` — the page itself

## Related

[[../tables/tickets]] · [[../inngest/ticket-csat]]

---

[[../README]] · [[../../CLAUDE]]
