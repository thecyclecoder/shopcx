# Index + split the findUnlinkedMatches OR query to stop full-table scans ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/account-matching.ts::real-bug`
**Repair-signature:** `supabase-logs:b5db594131381078`

Eliminate the whole-table sequential scan that findUnlinkedMatches performs on the 620k-row customers table, which intermittently produces 500s on GET /rest/v1/customers under concurrent portal-bootstrap load. Replace the single mixed .or() with per-branch indexed queries and add the supporting indexes so each branch is a bitmap index scan.

## Problem (from Control Tower signature `supabase-logs:b5db594131381078`)
src/lib/account-matching.ts builds `.or("and(first_name.eq.X,last_name.eq.Y),email.ilike.local@%")` against customers. EXPLAIN ANALYZE on prod (workspace fdc11e10…, 619,988 rows) shows a full Seq Scan removing 619,982 rows because the case-insensitive email ILIKE branch is non-indexable and the OR defeats the workspace_id index. Called on every portal bootstrap + sonnet orchestrator + journey builder, concurrent unindexed scans intermittently time out / saturate the pool → PostgREST 500 (signature supabase-logs:b5db594131381078, 2 hits 2026-06-22 16:00–19:45, since recovered).

**Likely target:** `src/lib/account-matching.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`. **Shipped:**
- `src/lib/account-matching.ts` — split the single mixed `.or(and(first_name,last_name),phone,email.ilike)` into three per-branch queries run via `Promise.all`, merged + deduped by id, capped at 10. Each branch now hits a single index (Bitmap Index Scan) instead of forcing a Seq Scan.
- `supabase/migrations/20260706130000_account_matching_indexes.sql` + `scripts/apply-account-matching-indexes-migration.ts` — added `idx_customers_name_match (workspace_id, first_name, last_name)` and `idx_customers_phone (workspace_id, phone)` partial. Email branch already covered by `idx_customers_email_trgm` (gin trgm, 2026-06-14). Apply script uses `CREATE INDEX CONCURRENTLY` (no long lock on the 620k-row hot table).
- `docs/brain/libraries/account-matching.md` — documented the per-branch-indexed-queries gotcha.

## Verification
- Apply the migration on prod: `npx tsx scripts/apply-account-matching-indexes-migration.ts` → expect `✓ present: ['idx_customers_name_match','idx_customers_phone']`.
- In a prod SQL console, `EXPLAIN ANALYZE` each branch query, e.g. `SELECT id, email FROM customers WHERE workspace_id = 'fdc11e10…' AND first_name = 'X' AND last_name = 'Y' LIMIT 10` → expect a **Bitmap/Index Scan** on the new index, **not** a Seq Scan of customers. Repeat for the phone and `email ILIKE 'local@%'` branches (email → `idx_customers_email_trgm`).
- Trigger a portal bootstrap for a customer that has a likely duplicate (shared name or phone) → expect the same `PotentialMatch[]` set as before (linking proposals unchanged), returned without a 500.
- Watch the Control Tower tile for signature `supabase-logs:b5db594131381078` under concurrent portal-bootstrap load → expect no new `error_events` row / loop_alert for it; tile stays green.

> Authored by the box Repair Agent from Control Tower signature `supabase-logs:b5db594131381078` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
