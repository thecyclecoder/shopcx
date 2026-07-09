---
title: Analytics-tile aggregation RPCs
last_updated: 2026-07-08
tags:
  - library
  - rpc
  - analytics
brain_refs:
  - [[tables/tickets]]
  - [[tables/ticket_directions]]
  - [[tables/ticket_resolution_events]]
  - [[tables/dunning_cycles]]
---

# Analytics-tile aggregation RPCs

Phase 1 of [[../specs/rpc-ify-aggregation-layer-fix-1000-row-truncation]] — the four `public.*` aggregate RPCs that back the analytics tiles whose prior `.select()` scans were silently truncated at PostgREST's 1000-row cap. Every RPC is workspace-scoped by its first argument, `LANGUAGE sql STABLE SECURITY DEFINER`, `SET search_path = public`, and `GRANT EXECUTE` to `service_role` + `authenticated`. Migration: [`20261005135000_phase1_analytics_rpcs.sql`](../../../supabase/migrations/20261005135000_phase1_analytics_rpcs.sql).

Each replaces a fetch-then-aggregate-in-JS site the audit flagged after [[storefront-ltv-proxy]] fixed the biggest offender (`estimate_sub_ltv`, #1525). The mistake shape: a `.select(cols).eq('workspace_id', …)` with **no** `.range()` returns at most 1000 rows via PostgREST, so any JS aggregation on top (percentile, group-by, filter counts) reads a truncated source — the counts LOOK plausible and the tile silently drifts as the workspace grows.

## 1. `analytics_sol_cost(p_workspace uuid, p_window_days int)`

**Caller:** [`src/app/api/tickets/analytics/sol-cost/route.ts`](../../../src/app/api/tickets/analytics/sol-cost/route.ts) — Sol economics tile at `/dashboard/tickets/analytics`.

**Replaces:** `tickets.select('id, ai_cost_cents, csat_score').eq('workspace_id', …).gte('created_at', since).is('merged_into', null)` + a per-ticket-directions rollup + JS percentile/cohort math.

**Returns** a single row with:

| Column | Type | Notes |
|---|---|---|
| `overall_count` / `overall_median_cents` / `overall_p95_cents` | `bigint` | percentile_cont over all window tickets (merged_into IS NULL) |
| `pre_sol_count` / `pre_sol_median_cents` / `pre_sol_p95_cents` | `bigint` | cohort with **no** [[../tables/ticket_directions]] rows |
| `sol_count` / `sol_median_cents` / `sol_p95_cents` | `bigint` | cohort with **≥1** [[../tables/ticket_directions]] row |
| `pre_sol_csat_count` / `sol_csat_count` | `bigint` | `csat_score IS NOT NULL` denominators |
| `pre_sol_csat_avg` / `sol_csat_avg` | `numeric` | avg [[../tables/tickets]]`.csat_score` per cohort |
| `resessions` | `jsonb` | array `[{ supersede_count, tickets }, …]` — the Sol-cohort re-session histogram (per-ticket rows in [[../tables/ticket_directions]] where `superseded_at IS NOT NULL`) |

**Signal:** the tile's median + p95 vs `catherine_baseline_cents=892` — see [[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]] and [[../tables/tickets]] `ai_cost_cents`.

## 2. `analytics_selective_clarify(p_workspace uuid, p_days int)`

**Caller:** [`src/app/api/tickets/analytics/selective-clarify/route.ts`](../../../src/app/api/tickets/analytics/selective-clarify/route.ts) — 7-day rolling selective-clarify rate tile.

**Replaces:** `ticket_resolution_events.select('verified_outcome').eq('workspace_id', …).gte('staged_at', since)` + a JS `for` tally.

**Returns:** one row with `total` + one `bigint` count per [[../tables/ticket_resolution_events]] `verified_outcome` enum value (`confirmed`, `unbacked`, `drifted`, `clarified`) + `unknown_count` (NULL bucket). The caller derives `clarified / total` as the rate; the tile targets ~6% per [[../specs/confidence-gated-problem-lockin-and-selective-clarify]].

## 3. `ai_ticket_analytics(p_workspace uuid, p_since timestamptz)`

**Caller:** [`src/app/api/workspaces/[id]/analytics/ai/route.ts`](../../../src/app/api/workspaces/[id]/analytics/ai/route.ts) — AI agent analytics dashboard.

**Replaces:** `tickets.select('id, channel, tags, escalated_at', {count:'exact'}).contains('tags', ['ai']).gte('created_at', since)` + a JS loop over the (1000-row-capped) rows for tag / channel / escalated tallies. `count:exact` was correct; every sub-bucket was wrong.

**Returns** a single row with:

| Column | Type | Notes |
|---|---|---|
| `ai_ticket_count` | `bigint` | count of tickets whose `tags @> ARRAY['ai']` in the window |
| `escalated` | `bigint` | `escalated_at IS NOT NULL` |
| `chat_count` / `email_count` | `bigint` | `channel = 'chat'` / `'email'` |
| `tag_buckets` | `jsonb` | `{ "<tag>": count, … }` from `unnest(tags)` |
| `ticket_ids` | `uuid[]` | the id set the caller then chunks through [[../tables/ticket_messages]] for the Sonnet decision-verb regex pass |

## 4. `dunning_cycle_status_counts(p_workspace uuid)`

**Caller:** [`src/app/api/workspaces/[id]/analytics/dunning/route.ts`](../../../src/app/api/workspaces/[id]/analytics/dunning/route.ts) — dunning analytics dashboard.

**Replaces:** `dunning_cycles.select('status, terminal_error_code').eq('workspace_id', …)` + six JS `.filter().length` passes. Every count (and the derived `recoveryRate`) was wrong on any workspace with >1000 cycles.

**Returns** one row: `total`, `active` (`status IN ('active','rotating')`), `retrying`, `skipped`, `recovered`, `exhausted`, `terminal` (`status='exhausted' AND terminal_error_code IS NOT NULL`) — all `bigint`. Columns match the `cycleStats` object shape the route already returns to the frontend, so the tile contract is unchanged.

## Gotchas

- All four functions are `STABLE SECURITY DEFINER SET search_path = public` — matches the pattern in [`20260708120000_estimate_sub_ltv_rpc.sql`](../../../supabase/migrations/20260708120000_estimate_sub_ltv_rpc.sql).
- The callers cast the RPC result with local `unknown`-first types + a numeric coercer (`Number(v) || 0`) because Postgres returns `bigint` as a string on the wire. Never trust the raw JS shape.
- Parity check for the fix: a workspace whose source-table row count exceeds 1000 in the queried window returns numbers matching a raw full-table SQL aggregate — the pre-fix JS did not.
- Adding a new outcome / status / channel needs an RPC update, not just a JS map key. Enumerated buckets live in SQL now.
