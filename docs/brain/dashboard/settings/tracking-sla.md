# Settings · settings/tracking-sla

Tracking SLA configuration for 3PL integration (Amplifier).

**Route:** `/dashboard/settings/tracking-sla`

## Features

**Page title:** Tracking SLA

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/tracking-sla/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
