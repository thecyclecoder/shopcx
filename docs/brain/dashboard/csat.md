# Dashboard · csat

CSAT survey dashboard. Resolution-gate stats (did we resolve?), rating distribution, comment list. Per-channel + per-agent breakdowns.

**Route:** `/dashboard/csat`

## Features

**Page title:** CSAT

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/csat`

## Permissions

All workspace members can view. The **Exclude from stats / Include** control on each CSAT row is OWNER-only — non-owners never see the button, and a direct `POST action:'exclude'` returns 403. See [[../tables/ticket_csat]] `excluded_at` / `excluded_by` / `exclusion_reason`.

## Files touched

- `src/app/dashboard/csat/page.tsx` — the page itself

## Related

[[../tables/tickets]] · [[../inngest/ticket-csat]]

---

[[../README]] · [[../../CLAUDE]]
