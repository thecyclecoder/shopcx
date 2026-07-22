-- Tighten per-table autovacuum on `public.orders` — DB Health Agent surface-don't-apply fix for
-- the `dbhealth:bloat:orders` signature (cause `bloat_vacuum_lag`). See
-- docs/brain/recipes/db-vacuum-tune-orders.md for the full sizing math + rollback + verification.
--
-- ⚠️ OWNER-APPROVAL-ONLY: this migration is NOT auto-applied by the build worker (mirrors the
-- surface-don't-apply stance in docs/brain/libraries/db-health.md § North star). It lands in the
-- PR for owner review; the owner runs it after review with:
--   npx tsx scripts/apply-orders-autovacuum-migration.ts
-- The apply-script also runs a one-off `VACUUM (ANALYZE) public.orders` to clear the current bloat
-- immediately; the reloptions below stop it from recurring. **No data is deleted** by any part of
-- this fix — VACUUM reclaims dead-tuple space and refreshes planner stats, it does not remove rows.
--
-- ── Evidence quoted verbatim from the DB Health Agent bloat pass ─────────────────────────────
--   Signature: dbhealth:bloat:orders
--   Cause:     bloat_vacuum_lag (dead-tuple ratio ≥ BLOAT_DEAD_RATIO_FLAG=20% on a big hot table
--              whose last autovacuum is stale ≥ BLOAT_AUTOVACUUM_STALE_MS=24h, or the trend pass
--              caught the dead ratio climbing ≥ BLOAT_TREND_RISE=5 points across the window).
-- The default cluster autovacuum_vacuum_scale_factor = 0.20 means autovacuum only fires after 20%
-- of the table is dead — on a hot, write-heavy table like `orders` (subscription-fulfillment
-- churn + address/status updates) that leaves the plan reading through a large minority of dead
-- rows between runs. The bloat pass's finding IS this lag.
--
-- ── The tune (per-table, no cluster-wide change) ─────────────────────────────────────────────
-- Scoped to `orders` via ALTER TABLE ... SET (reloptions). Cluster defaults for every other table
-- stay put — a per-table tune isolates the bounded change to the hot table.
--   autovacuum_vacuum_scale_factor  = 0.05   (fire at 5% dead, not 20% — 4× more often)
--   autovacuum_analyze_scale_factor = 0.02   (refresh stats at 2% churn — planner sees reality)
--   autovacuum_vacuum_threshold     = 1000   (still require ≥1000 dead rows so a nearly-empty
--                                             table isn't chased; the SCALE_FACTOR dominates on
--                                             a table this size)
-- The combined predicate autovacuum uses is:
--   dead_tuples > threshold + scale_factor × reltuples
-- At orders' scale the scale_factor term dominates, so a 4× tighter scale_factor gives roughly 4×
-- more autovacuum passes — enough to hold the dead-tuple ratio below the DB Health Agent's
-- BLOAT_DEAD_RATIO_FLAG (20%) between passes. Values chosen to mirror the pgtune / SUPABASE
-- Postgres 15 large-hot-table recommendation, NOT a max-aggression floor (0.01) which would run
-- autovacuum continuously and steal write throughput.
--
-- ── Verification (per the spec's `## Verification` bullet) ───────────────────────────────────
-- On the DB Health Agent's next bloat pass (~daily, DB_HEALTH_SIZE_LOOP_ID), the signature
-- `dbhealth:bloat:orders` is no longer flagged — `n_dead_tup / (n_live_tup + n_dead_tup)` drops
-- below 0.20 and `last_autovacuum` is fresh (< 24h) — and no duplicate proposal is created (the
-- enqueue dedup honors DB_HEALTH_REPROPOSE_WINDOW_MS = 7d).
--
-- ── Rollback (reversible in a single statement, <1s) ────────────────────────────────────────
--   alter table public.orders reset (
--     autovacuum_vacuum_scale_factor,
--     autovacuum_analyze_scale_factor,
--     autovacuum_vacuum_threshold
--   );
-- Autovacuum reverts to the cluster defaults immediately; the one-off VACUUM's reclamation is
-- already permanent (it moved dead space back to the free-space map).

alter table public.orders set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000
);
