# Dashboard · analytics/ai

AI agent analytics: daily quality scores, what the orchestrator is doing (decisions/actions/tags), escalation rate, and **token cost + cache utilization** per ticket.

**Route:** `/dashboard/analytics/ai`

## Features

**Page title:** AI Agent Analytics

**Rendering:** `"use client"` component (client-side state + fetch). Window selector (7/14/30/60/90d).

**Cost & cache (the per-ticket-cost lever):** the "Token usage & cost" section surfaces a **Cache hit %** = share of input-side tokens served from cache (cheap reads) vs re-paid (raw input + cache creation). This is the metric the orchestrator pre-context split ([[../libraries/sonnet-orchestrator-v2]]) tunes — higher = lower per-ticket cost. Also shows per-ticket cost, Opus share, monthly run-rate.

**Yesterday vs today:** a live day-over-day compare (Central time) of cost, per-ticket cost, cache hit %, tickets, and Opus/Sonnet split — built from the `periods` block the API returns. Today is partial (totals accrue through the day; cache hit % is a rate, so it's comparable mid-day). This is where you watch the caching win land.

**Gotcha (fixed):** `ai_token_usage` exceeds PostgREST's 1000-row cap for a 30-90d window. The route now **paginates** the fetch (`.range()` loop, ordered) — before, it silently aggregated only the oldest 1000 rows, undercounting cost and excluding recent days.

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/ai`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/ai/page.tsx` — the page itself
- `src/app/api/workspaces/[id]/analytics/ai/route.ts` — aggregates `ai_token_usage` (paginated): cost, cache utilization, today/yesterday `periods`

---

[[../README]] · [[../../CLAUDE]]
