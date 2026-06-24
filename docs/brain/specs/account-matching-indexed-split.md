# Index + split the findUnlinkedMatches OR query to stop full-table scans ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/account-matching.ts::real-bug`
**Repair-signature:** `supabase-logs:b5db594131381078`

Eliminate the whole-table sequential scan that findUnlinkedMatches performs on the 620k-row customers table, which intermittently produces 500s on GET /rest/v1/customers under concurrent portal-bootstrap load. Replace the single mixed .or() with per-branch indexed queries and add the supporting indexes so each branch is a bitmap index scan.

## Problem (from Control Tower signature `supabase-logs:b5db594131381078`)
src/lib/account-matching.ts builds `.or("and(first_name.eq.X,last_name.eq.Y),email.ilike.local@%")` against customers. EXPLAIN ANALYZE on prod (workspace fdc11e10…, 619,988 rows) shows a full Seq Scan removing 619,982 rows because the case-insensitive email ILIKE branch is non-indexable and the OR defeats the workspace_id index. Called on every portal bootstrap + sonnet orchestrator + journey builder, concurrent unindexed scans intermittently time out / saturate the pool → PostgREST 500 (signature supabase-logs:b5db594131381078, 2 hits 2026-06-22 16:00–19:45, since recovered).

**Likely target:** `src/lib/account-matching.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `supabase-logs:b5db594131381078`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `supabase-logs:b5db594131381078` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
