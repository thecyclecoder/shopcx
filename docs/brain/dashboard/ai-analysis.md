# Dashboard · ai-analysis

Daily AI quality analysis dashboard. Low-score tickets, gap patterns, research-and-heal status. Paused 2026-04-28; surface remains for review.

**Route:** `/dashboard/ai-analysis`

## Features

**Page title:** AI Analysis

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[ai-analysis/[id]]]

## API endpoints called

- `/api/workspaces/:x/ticket-analyses`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/ai-analysis/page.tsx` — the page itself
- `src/app/dashboard/ai-analysis/[id]/page.tsx` — sub-route

## Related

[[../tables/ticket_analyses]] · [[../tables/daily_analysis_reports]] · [[../tables/ai_token_usage]] · [[../tables/knowledge_gaps]] · [[../inngest/ai-nightly-analysis]] · [[../lifecycles/research-and-heal]]

---

[[../README]] · [[../../CLAUDE]]
