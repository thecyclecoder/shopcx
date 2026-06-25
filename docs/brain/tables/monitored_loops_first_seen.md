# monitored_loops_first_seen

The Control Tower's **empirical first-observed-at anchor** for the `registered_not_firing` grace ([[../specs/control-tower]] + [[../specs/error-feed-monitoring]] line, refined by `control-tower-registered-not-firing-observed-anchor-grace` Phase 1). [[../libraries/control-tower]] `buildControlTowerSnapshot` upserts one row per registered loop the FIRST time it sees it; every subsequent tick is an `on conflict do nothing` no-op. The grace anchor in [[../libraries/control-tower]] `evalCron` then takes `max(firstScheduledFiringMs, first_seen_at)` so a hand-edited `MonitoredLoop.registeredAt` set BEFORE the cron actually shipped can't shorten the grace below "we have empirically seen this loop registered for at least one full window."

**Why it exists:** `fleet-spend-governor` registered `2026-06-25T00:00:00Z` with cadence `(10,40 * * * *)` had its computed first firing rounded to `00:10` SAME day, so a 90-min `livenessWindowMs` expired the moment the deploy actually landed mid-morning — false-paging the [[../control-tower]] `loop:fleet-spend-governor` signal the moment ship hit prod.

**Global infra, not workspace-scoped** (mirrors [[loop_heartbeats]] / [[loop_alerts]] / [[worker_heartbeats]]). RLS: any authenticated user reads; service role writes.

**Primary key:** `loop_id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `loop_id` | `text` | PK · the registry id (`MonitoredLoop.id`) — one row per registered loop |
| `first_seen_at` | `timestamptz` | when [[../libraries/control-tower]] first saw this loop · default `now()` (overridden by the tick timestamp on insert so the upserted row is immediately usable in the same tick) |

## Write contract

- `buildControlTowerSnapshot` reads the whole table (tiny — one row per loop), builds a `loop_id → first_seen_at` map, then **upserts** a fresh row for every `MONITORED_LOOPS` entry NOT already in the map with `onConflict: "loop_id", ignoreDuplicates: true`.
- **First sight wins** — every subsequent tick is a no-op at the DB.
- **Best-effort.** A transient DB error is logged + swallowed: the empirical anchor refines the existing grace (still backed by `firstScheduledFiringMs(registeredAt)`), so a failed write never breaks the snapshot or false-pages anything.

## Read contract

- The `loop_id → first_seen_at(ms)` map is built once per snapshot.
- For each `cron`-kind loop, `evalCron` is called with the row's value (or `null` if absent — first tick that has never made it past the upsert yet). `firstScheduledFiringMs(loop, firstObservedMs)` then takes the LATER of the computed first firing and the observed anchor.
- An observed anchor EARLIER than the computed first firing is ignored — it would only pull the grace BACK, which is never the goal.

## Gotchas

- **No purge yet.** A loop removed from `MONITORED_LOOPS` keeps its row (one orphan row per retired loop). The table is tiny; revisit only if it ever grows materially.
- **Not a substitute for `registeredAt`.** This is the empirical refinement of an already-graced clock — a brand-new cron that ships and SHOULD start firing still gets caught by the deploy-anchored `never_fired` check + the watchdog-uptime `registered_not_firing` check once a full window of empirical visibility has elapsed with 0 beats.

## Migration

`supabase/migrations/20260725150000_monitored_loops_first_seen.sql` (create table + RLS).

## Related

[[../libraries/control-tower]] · [[loop_alerts]] · [[loop_heartbeats]] · [[../inngest/control-tower-monitor]] · [[../dashboard/control-tower]]
