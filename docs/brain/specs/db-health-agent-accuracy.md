# DB Health Agent — accuracy upgrade (filter foreign, slow-vs-volume, sunset allowlist) ⏳

**Owner:** [[../functions/platform]] · **Parent:** sharpens [[db-health-agent]]. · **Found in use 2026-06-23:** the agent's first real run surfaced 5 slow-query findings — but only **1 of 5 was actionable** (an `orders` composite-index win, approved). The other 4 exposed three classification gaps: it proposed `vacuum`/`bloat` for a *foreign* query, a *sunset* table, and two *high-call-volume-not-slow* queries. The detection (ranking by total time) is good; the **fix classification** is weak. Fix the three gaps.

## The three gaps (from the review)
1. **Filter foreign / internal queries — don't propose fixes for queries we don't own.** The #1-by-total-time finding was the **Supabase Realtime WAL decoder** (`SELECT wal->>'type' …`) — Supabase-internal replication, not ours to index. Also PostgREST internals / `pg_*` catalog queries. Add a foreign-query filter (by query shape: `wal->>`, `pgrst_`, `pg_catalog`, `information_schema`, realtime/`_realtime` schema, supabase_admin role) — mirror the [[repair-agent]] **foreign-app-noise** class. A foreign query is never a proposal.
2. **Distinguish slow-per-call (→ index/rewrite) vs fast-but-hammered (→ reduce calls / cache).** A query at **4 ms mean × 1.27 M calls** ranks high by total time but is NOT a `vacuum`/index candidate — it's a hot endpoint (e.g. the dashboard ticket-poll). Classify by **mean_exec_time**: ≥ ~50 ms ⇒ a real per-call problem (EXPLAIN → index/rewrite); < ~say 20 ms but huge call count ⇒ **call-volume** finding → propose *reduce call frequency / cache / a covering or partial index for the hot predicate* (and for an array predicate like `tags @>`, a **GIN index**), NOT vacuum. Default to `vacuum/bloat` ONLY when EXPLAIN actually shows bloat/stale-stats, never as the catch-all.
3. **Allowlist sunset / retiring systems.** Don't propose fixes for tables being retired (Klaviyo — `klaviyo_*` — is being turned off). Reuse / mirror the [[control-tower-migration-drift-check]] sunset allowlist; an allowlisted table's queries are skipped.

## Verification
- The realtime WAL / any `wal->>`, `pgrst_`, `pg_catalog`, `_realtime`-schema query → **never** produces a `db_health` proposal (foreign-filtered); a genuine `public.*` app query still does.
- A query with **mean < 20 ms but very high calls** → the proposal's cause is **`high_call_volume`** (not `bloat`) and its fix proposes call-reduction / cache / a hot-predicate index (GIN for an array `@>`), with the call count + mean cited — not a vacuum.
- A query with **mean ≥ 50 ms on a big table** → still an index/rewrite proposal (the orders-class win), unchanged.
- A `klaviyo_*` (allowlisted-sunset) query → **no** proposal.
- A real bloat case (EXPLAIN shows high dead-tuple / stale stats) → still a `vacuum` proposal (the label isn't removed, just stops being the catch-all).
- Negative: the legit `orders` composite-index finding still surfaces under the new classifier.

## Phase 1 — foreign filter + slow-vs-volume classifier + sunset allowlist ⏳
In [[../libraries/db-health]]: add `isForeignQuery()` (shape-based) applied before proposing; split the cause classifier into `slow_per_call` (EXPLAIN → index/rewrite) vs `high_call_volume` (→ reduce-calls / cache / hot-predicate or GIN index) keyed off `mean_exec_time`; add a `DB_HEALTH_SUNSET_ALLOWLIST` (`klaviyo_*`, …). Re-run the slow-query pass after to re-propose under the sharper logic. Brain: [[db-health-agent]] · [[../libraries/db-health]] · [[repair-agent]] · [[control-tower-migration-drift-check]].
