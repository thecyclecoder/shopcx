# Dashboard · ai-analysis

Daily AI quality analysis dashboard. Low-score tickets, gap patterns, research-and-heal status. Paused 2026-04-28; surface remains for review.

**Route:** `/dashboard/ai-analysis`

## Features

**Page title:** AI Analysis

**Visible buttons (heuristic — actual labels in source):**
- Accept manually
- Reject manually
- Revert to proposed

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[ai-analysis/[id]]]

## API endpoints called

- `/api/sonnet-prompts/:x/override`
- `/api/workspaces/:x/sonnet-prompt-decisions`
- `/api/workspaces/:x/ticket-analyses`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/ai-analysis/page.tsx` — the page itself
- `src/app/dashboard/ai-analysis/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
