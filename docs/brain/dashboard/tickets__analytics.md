# Dashboard · tickets/analytics

Measurement surface for the confidence-gated problem-lockin + selective-clarify + Sol economics work. Two tiles:

1. **Selective-clarify rate (target ~6%)** — from [[../tables/ticket_resolution_events]] `verified_outcome='clarified'` over a rolling 7d window ([[../specs/confidence-gated-problem-lockin-and-selective-clarify]] Phase 2).
2. **Sol economics** — per-ticket AI cost (median + p95), split by pre-Sol vs Sol cohort ("has any [[../tables/ticket_directions]] row" — Sol = yes), CSAT average per cohort, and a re-session histogram bucketed by count of superseded Directions per ticket. References the Catherine $8.92 baseline as a dashed line and (once Phase 4 lands) the latest shadow-replay median as a second reference. Empty-state safe: with zero Sol tickets in the window, the tile still renders the pre-Sol cohort. Phase 3 of [[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]].

**Route:** `/dashboard/tickets/analytics`

## Features

**Page title:** Ticket analytics

**Rendering:** `"use client"` component (client-side state + fetch) wrapped in a `<Suspense>` boundary — required by `cacheComponents: true` in next.config (see CLAUDE.md § cacheComponents RULES).

## API endpoints called

- `/api/tickets/analytics/selective-clarify`
- `/api/tickets/analytics/sol-cost`

The `sol-cost` endpoint returns:

```json
{
  "window_days": 30,
  "catherine_baseline_cents": 892,
  "shadow_baseline_cents": 617,
  "cost": {
    "overall": { "count": 0, "median_cents": 0, "p95_cents": 0 },
    "pre_sol": { "count": 0, "median_cents": 0, "p95_cents": 0 },
    "sol":     { "count": 0, "median_cents": 0, "p95_cents": 0 }
  },
  "csat": {
    "pre_sol": { "count": 0, "avg": null },
    "sol":     { "count": 0, "avg": null }
  },
  "resessions": [{ "supersede_count": 0, "tickets": 0 }]
}
```

`shadow_baseline_cents` is `null` until Phase 4's `sol_replay_runs` has at least one row.

## Permissions

Owner / admin / cs_manager only (both endpoints hard-gate at the API layer).

## Files touched

- `src/app/dashboard/tickets/analytics/page.tsx` — the page itself
- `src/app/api/tickets/analytics/selective-clarify/route.ts` — clarify-rate endpoint
- `src/app/api/tickets/analytics/sol-cost/route.ts` — Sol economics endpoint

---

[[../README]] · [[../../CLAUDE]] · [[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]] · [[../specs/confidence-gated-problem-lockin-and-selective-clarify]]
