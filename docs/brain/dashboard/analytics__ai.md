# Dashboard · analytics/ai

_TODO: page purpose._

**Route:** `/dashboard/analytics/ai`

## Features

**Page title:** AI Agent Analytics

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/ai` — backed by [[../libraries/analytics-tile-rpcs]] `ai_ticket_analytics` RPC

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/ai/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
