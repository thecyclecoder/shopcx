# Raise work_mem (owner-approval-only)

The recipe behind the [[../libraries/db-health|DB Health Agent]]'s `raise_work_mem` fix kind — the surface-don't-apply response to the `dbhealth:instance:temp_spill_pressure` signature. Escalation-shaped: `work_mem` is a per-connection setting that eats RAM per open session, so an unbounded cluster-wide bump can push the instance into swap. This recipe is the bounded, reversible starting move.

**Source of truth:** `supabase/migrations/20260811120000_raise_authenticated_work_mem.sql` + `scripts/apply-raise-work-mem-migration.ts`.

## When to apply

The DB Health Agent's [[../libraries/db-health|instance-saturation pass]] (`DB_HEALTH_INSTANCE_LOOP_ID`, ~15 min) surfaces a `dbhealth:instance:temp_spill_pressure` proposal when cumulative `pg_stat_database.temp_bytes` crosses `INSTANCE_TEMP_BYTES_WINDOW_FLAG` (100 GB). The 2026-07-02 outage tripped this at 883 GB / 92,832 files; the trigger for this recipe was 908 GB / 95,077 files. Every hash/sort node whose working set exceeds `work_mem` spills to disk — the default 4 MB Supabase floor turns any moderately-sized aggregate into a spiller, dragging every heavy query.

**Cheaper-win check first.** The spec explicitly says: *"sometimes an index on the ORDER BY / GROUP BY is the cheaper win."* Before raising `work_mem`, run the DB Health slow-query panel (`DB_HEALTH_SLOWQ_LOOP_ID`) and look for a plan with `Sort Method: external merge` or `Disk: NkB` on a single dominant query — if one exists, add the covering index for that query instead of raising the instance floor.

## The bump (bounded to one role)

Cluster-wide `work_mem = X` amplifies X across every backend the pooler opens — background workers, replication, cron — and each one holds it for their session lifetime. That's why we don't touch the cluster default. Instead the migration bumps only the `authenticated` role — the Supabase REST/SSR identity that serves the dashboard aggregates doing the spilling.

```sql
alter role authenticated set work_mem = '16MB';
alter role authenticated set hash_mem_multiplier = '2.0';
```

- **`work_mem = 16MB`** — 4× the Supabase default. Sorts and hash-inserts use up to this before spilling.
- **`hash_mem_multiplier = 2.0`** (PG13+) — hash-node operations can use `work_mem × 2` = 32 MB before spilling. The 2026-07-02 incident was dominated by *hash* spills specifically, so doubling the multiplier concentrates headroom where the evidence points, without doubling every SORT's ceiling.

## The RAM math

The `buildFixSpecMarkdown` guidance for `temp_spill_pressure` (see `docs/brain/libraries/db-health.md`) states the constraint:

```
max_connections × work_mem  ≤  RAM − shared_buffers − OS cache headroom
```

Because the migration scopes the bump to the `authenticated` role, the multiplier isn't `max_connections` — it's *concurrent authenticated sessions*, which in steady state runs ~20 for the dashboard SSR reads. So the worst-case new usage is:

```
20 authenticated sessions × 16 MB ≈ 320 MB peak
```

On a Supabase Small (4 GB RAM, ~1 GB `shared_buffers`, ~1 GB OS headroom) that leaves ~2 GB of work-memory envelope — 320 MB fits comfortably. Every larger tier has strictly more headroom.

If the instance is running a smaller tier (or the concurrent-session count is materially higher than 20), pull the numbers before applying:

```sql
select current_setting('shared_buffers'), current_setting('max_connections');
select count(*) from pg_stat_activity where usename = 'authenticated';
```

…and reduce the bump proportionally (`8MB` first, then re-check) or extend the sizing to a larger tier.

## Verification

Per the spec (`docs/brain/libraries/db-health.md` § buildFixSpecMarkdown Verification): on the DB Health Agent's next instance pass (~15 min after apply), the `dbhealth:instance:temp_spill_pressure` signature is no longer flagged — cumulative `pg_stat_database.temp_bytes` stops climbing at the pre-fix rate, and the enqueue dedup (`DB_HEALTH_REPROPOSE_WINDOW_MS = 7d`) prevents a duplicate proposal.

Watch the tile: the instance pass beats `ok:false` (`produced.status:'active_incident'`) when a finding is live and flips to `ok:true` when none are — the reddening tile is the operator-visible signal that the fix landed.

## Rollback

Reversible in a single statement each (< 1 s):

```sql
alter role authenticated reset work_mem;
alter role authenticated reset hash_mem_multiplier;
```

Sessions opened AFTER the reset revert to the cluster default `work_mem` immediately. Existing sessions keep whatever they attached with until they end.

## Gotchas

- **Scoped to `authenticated` — not `authenticator`, not cluster-wide.** The `authenticator` role logs in and switches to `authenticated` (or `anon`) via `SET ROLE`. `ALTER ROLE ... SET work_mem` applies to sessions running *as* that role, so a bump on `authenticated` catches the SSR path without the `authenticator` login role holding memory across the switch. The box worker's `scripts/*` scripts log in as `postgres` (via the pooler DB password) so they're **not** affected by this bump — a separate decision if a box worker's read is spilling.
- **PGBouncer pooling doesn't cache the value.** `ALTER ROLE ... SET` writes to `pg_roles.rolconfig`, applied at session start. In Supabase's transaction pooler (:6543) each pooled connection reads the config when it opens; existing pool connections keep their attached value until they cycle.
- **No `SET LOCAL` needed.** `ALTER ROLE ... SET` is the durable form — the target is a floor for that role, not a per-transaction override.
- **Idempotent.** Re-running the migration/apply-script just re-sets the same value; safe under a resume or a follow-up owner tap.

## Related

- [[../libraries/db-health]] — the DB Health Agent detector + `raise_work_mem` fix kind + the `temp_spill_pressure` signature.
- [[../operational-rules]] § North star — the supervisable-autonomy principle behind surface-don't-apply for high-stakes DB settings.
- [[write-a-migration-apply-script]] — the `scripts/apply-*.ts` pattern this recipe's apply-script follows.
- [[../tables/db_table_size_history]] — the size-sweep companion (the growth/bloat side of the DB Health surface).
