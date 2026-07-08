# Recipe: backfill ticket ai_cost_cents (`backfill-ticket-ai-cost`)

Populate [[../tables/tickets]] `ai_cost_cents` for historical rows by summing [[../tables/ai_token_usage]] rows joined by `ticket_id` and converting tokens → cents via [[../libraries/ai-usage]] `usageCostCents`. Feeds the Sol economics analytics tile ([[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]] § Phase 3) once the running per-turn stamp (Phase 1) has taken over new rows.

**Tool:** `scripts/backfill-ticket-ai-cost.ts`. Dry-run by default; `--apply` writes.

## Commands

```bash
# Dry run — prints a per-chunk manifest of the deltas, no writes
npx tsx scripts/backfill-ticket-ai-cost.ts

# Apply — writes UPDATE tickets SET ai_cost_cents=$sum WHERE id=$id (CAS on read value)
npx tsx scripts/backfill-ticket-ai-cost.ts --apply

# Custom chunk size (default 500)
npx tsx scripts/backfill-ticket-ai-cost.ts --apply --chunk 1000
```

## What it does

1. Cursors on `public.tickets` ordered by `created_at DESC`, chunks of 500 (or `--chunk N`).
2. For each chunk: batch-selects the chunk's `ai_token_usage` rows via `ticket_id = ANY(...)`.
3. Sums `usageCostCents(model, row)` per `ticket_id`, rounds to whole cents.
4. Skips rows whose stored `ai_cost_cents` already matches the computed sum (already-correct fast path).
5. Under `--apply`, writes `UPDATE tickets SET ai_cost_cents=$sum WHERE id=$id AND ai_cost_cents=$read_value` — a compare-and-set on the read-time value so a concurrent per-turn stamp from [[../libraries/action-executor]] (via `add_ticket_ai_cost` RPC) doesn't get clobbered by an async-stale sum. A CAS miss is safe — the row is picked up on the next re-run.
6. Prints per-chunk `seen · would-change · sum(to) · oldest` diagnostics and a final tally.

## Idempotency

- **Full-sum semantics.** The script writes the TOTAL per-ticket sum, not a delta. Re-running after `--apply` finds every row already correct and reports zero writes.
- **Compare-and-set guard.** The write asserts the read-time `ai_cost_cents` value in the WHERE clause — a concurrent turn's `add_ticket_ai_cost` increment during the same chunk is preserved (the CAS misses, the row is re-computed next pass).
- **Cursor is stable.** `created_at DESC` — new tickets get their running per-turn stamp from the executor; the backfill only needs to catch up on rows created before Phase 1 landed.

## Verification (post-apply)

- Random sample of 20 backfilled tickets: `tickets.ai_cost_cents` matches `SUM(usageCostCents)` over the ticket's `ai_token_usage` rows.
- Re-run `--apply`: no rows written (idempotent).

## Related

[[../specs/sol-cost-csat-measurement-vs-pre-sol-baseline]] · [[../tables/tickets]] · [[../tables/ai_token_usage]] · [[../libraries/ai-usage]] · [[../libraries/action-executor]]
