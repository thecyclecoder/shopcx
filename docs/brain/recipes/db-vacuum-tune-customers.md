# Vacuum / autovacuum-tune customers (owner-approval-only)

The recipe behind the [[../libraries/db-health|DB Health Agent]]'s `vacuum_tuning` fix kind applied to `public.customers` — the surface-don't-apply response to the `dbhealth:bloat:customers` signature (cause `bloat_vacuum_lag`). Escalation-shaped like [[raise-work-mem]]: a `VACUUM` reclaims space but takes I/O; a per-table autovacuum re-tune ripples until it finds the right steady state. This recipe is the bounded, reversible starting move — **no data is deleted**.

**Source of truth:** `supabase/migrations/20260819120000_customers_autovacuum_scale_factor.sql` + `scripts/apply-customers-autovacuum-migration.ts`.

## When to apply

The DB Health Agent's [[../libraries/db-health|bloat pass]] (`DB_HEALTH_SIZE_LOOP_ID`) surfaces a `dbhealth:bloat:customers` proposal when the `customers` table crosses two floors together:

- `n_dead_tup / (n_live_tup + n_dead_tup) ≥ BLOAT_DEAD_RATIO_FLAG` (20%) **and**
- `last_autovacuum` is stale (older than `BLOAT_AUTOVACUUM_STALE_MS` = 24h) or never fired.

(The trend variant `analyzeBloatTrend` catches the same table earlier, at a `BLOAT_TREND_MIN_RATIO` = 10% dead ratio with a `BLOAT_TREND_RISE` = +5-point climb across the window while autovacuum isn't advancing.)

Diagnosed cause: the default cluster `autovacuum_vacuum_scale_factor = 0.20` means autovacuum only fires after **20%** of the table is dead. On a hot, write-heavy table like `customers` (~620k rows with churn from `retention_score` / `ltv_cents` / `subscription_status` / `email_marketing_status` / `sms_marketing_status` / `last_order_at` rewrites on every order + every lifecycle transition, plus the account-matching / linked-account paths that touch identity columns) that leaves a large minority of dead rows to be scanned between passes. The bloat pass's finding *is* this lag.

## The tune (per-table, no cluster-wide change)

Scoped to `public.customers` via `ALTER TABLE ... SET (reloptions)`. Cluster defaults for every other table stay put — the isolation is the point (mirrors [[raise-work-mem]]'s "scope to one role" story).

```sql
alter table public.customers set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_threshold     = 1000
);
```

- **`autovacuum_vacuum_scale_factor = 0.05`** — fire at 5% dead, not 20% (4× more often). Autovacuum's fire predicate is `dead_tuples > threshold + scale_factor × reltuples`; at `customers` scale (~620k live rows) the scale_factor term dominates, so 4× tighter gives ≈4× more passes — enough to hold the dead-tuple ratio below the DB Health Agent's `BLOAT_DEAD_RATIO_FLAG` (20%) between runs. Not the max-aggression 0.01 floor, which would run autovacuum continuously and steal read/write throughput from the checkout / retention-score / phone-and-email match paths that hit `customers` on every request.
- **`autovacuum_analyze_scale_factor = 0.02`** — refresh planner stats at 2% churn. Keeps `pg_stats` fresh so plans don't drift as `email_marketing_status` / `subscription_status` / `retention_score` / `ltv_cents` shift under a table this many indexes deep (see the trigram email index, the phone-last10 expression index, the name-match index).
- **`autovacuum_vacuum_threshold = 1000`** — floor. Prevents a small table from being chased; at `customers` size the scale_factor dominates, but the floor guards against edge cases (post-truncate, dev fixtures).

## The one-off `VACUUM (ANALYZE)`

The reloptions above stop the bloat from **recurring**, but existing dead-tuple backlog waits for the next natural pass to be reclaimed. The apply-script issues one `VACUUM (ANALYZE) public.customers` after the ALTER TABLE — clears the current backlog and refreshes stats immediately so the DB Health Agent's next bloat pass reads a fresh `last_autovacuum` + a sub-threshold `n_dead_tup / (n_live_tup + n_dead_tup)`.

`VACUUM` **does not delete rows** — it moves dead-tuple space back to the free-space map and updates statistics. It is safe to re-run; the apply-script is idempotent end to end. `VACUUM` cannot run inside a transaction block, so the apply-script sends it as its own statement after the migration commits.

## Verification

Per the spec (`docs/brain/libraries/db-health.md` § buildFixSpecMarkdown Verification): on the DB Health Agent's next bloat pass, the `dbhealth:bloat:customers` signature is no longer flagged — `n_dead_tup / (n_live_tup + n_dead_tup)` drops below `BLOAT_DEAD_RATIO_FLAG` (0.20) **and** `last_autovacuum` is fresh (< `BLOAT_AUTOVACUUM_STALE_MS` = 24h). The enqueue dedup (`DB_HEALTH_REPROPOSE_WINDOW_MS = 7d`) prevents a duplicate proposal while the fix settles.

Watch the DB Health size-sweep tile: the pass beats `ok:false` (`produced.status:'active_incident'`) when a bloat finding is live and flips to `ok:true` when none are — the reddening tile is the operator-visible signal that the fix landed.

The apply-script also prints the post-`VACUUM` dead-tuple picture (`n_live_tup`, `n_dead_tup`, `dead_ratio`, `last_autovacuum`, `last_analyze`) — a sanity check that the immediate reclaim actually cleared the flagged snapshot before the next agent pass runs.

## Rollback

Reversible in a single statement (the reloptions revert to the cluster defaults immediately):

```sql
alter table public.customers reset (
  autovacuum_vacuum_scale_factor,
  autovacuum_analyze_scale_factor,
  autovacuum_vacuum_threshold
);
```

The one-off `VACUUM`'s reclamation is already durable — the freed dead-tuple space is back in the free-space map and cannot be "un-reclaimed"; the reset above only restores the tune, not the pre-fix bloat.

## Gotchas

- **Per-table, not cluster-wide.** `ALTER TABLE ... SET (reloptions)` writes to `pg_class.reloptions` on the target relation only. Other tables keep the Supabase cluster defaults; a downstream `dbhealth:bloat:<other_table>` proposal is handled with its own per-table tune (this recipe generalizes — swap the table name).
- **`VACUUM` ≠ `VACUUM FULL`.** This recipe uses plain `VACUUM (ANALYZE)`, which is non-blocking (an `AccessShareLock`, coexists with reads and writes). `VACUUM FULL` rewrites the table and takes an `AccessExclusiveLock` — never in this recipe; it would freeze `customers` reads/writes for the duration, breaking every checkout/portal/webhook path that touches the table.
- **No data is deleted.** `VACUUM` reclaims *dead* tuples (rows an earlier `UPDATE`/`DELETE` already superseded). Live rows are untouched. This is the sense in which the fix is safe to auto-approve if the owner chooses to.
- **The reload options apply to the *next* autovacuum decision.** An autovacuum worker running when the migration lands finishes with the old settings; subsequent decisions read the new reloptions. No restart required.
- **Idempotent.** Re-running the migration/apply-script just re-sets the same reloptions and re-issues a `VACUUM (ANALYZE)` (safe under a resume or a follow-up owner tap).
- **The tune is the guardrail, not a silver bullet.** If `customers`-column churn genuinely grows past what 5% can absorb (rare — the steady-state churn from lifecycle rewrites is well under this), the DB Health Agent will re-flag `dbhealth:bloat:customers` after the 7d re-propose window, and the next tune tightens further (0.03 → 0.02) or the root cause is investigated (an untuned bulk-update batch, a runaway retention-score recompute, a bad backfill).

## Related

- [[../libraries/db-health]] — the DB Health Agent detector + `vacuum_tuning` fix kind + the `bloat_vacuum_lag` cause.
- [[../operational-rules]] § North star — the supervisable-autonomy principle behind surface-don't-apply for DDL / DB settings.
- [[write-a-migration-apply-script]] — the `scripts/apply-*.ts` pattern this recipe's apply-script follows.
- [[raise-work-mem]] — the sibling instance-saturation recipe (temp-spill pressure) with the same surface-don't-apply shape.
- [[../tables/customers]] — the target table (columns, indexes, prior DB Health fix history).
- [[../tables/db_table_size_history]] — the size-sweep companion that feeds the bloat classifier.
