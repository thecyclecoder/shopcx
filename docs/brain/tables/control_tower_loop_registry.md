# control_tower_loop_registry

Per-loop **"first time the monitor observed this loop registered"** anchor ([[../specs/control-tower-registered-not-firing-new-cron-grace]]). The [[../inngest/control-tower-monitor]] cron stamps `first_observed_at` the first time it sees a cron loop id (insert-if-absent, **never updated**), and [[../libraries/control-tower]]'s `evalCron` reads it back to grace the `registered_not_firing` check for newly-added crons.

**Why it exists:** the `registered_not_firing` guard pages a registered cron with 0 heartbeats ever once the watchdog has been alive longer than the cron's cadence+grace window. But that uptime is the **watchdog's**, not the cron's — a cron added after the box came up (the common case) inherits the box's long uptime and trips the moment it's registered, before its first scheduled tick can fire (the `loop:storefront-lever-decay-cron` false positive: paged 9h before any fire was possible). `now - first_observed_at` is a deploy-surviving lower bound on how long the monitor has **known this specific cron**, so the guard gates on `min(monitorUptimeMs, now - first_observed_at) > window` and a new cron always gets a full window before it can flip red.

**Global infra, not workspace-scoped** (same as [[loop_heartbeats]] / [[loop_alerts]] / [[worker_heartbeats]]). RLS: any authenticated user reads; service role writes.

**Primary key:** `loop_id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `loop_id` | `text` | PK · the loop's stable registry id (matches [[loop_heartbeats]]`.loop_id`) |
| `kind` | `text?` | the loop kind (`cron` — only crons are stamped today) |
| `first_observed_at` | `timestamptz` | when the monitor first saw this loop registered · default `now()` · **written once, never moved** (the upsert uses `ignoreDuplicates`) |
| `created_at` | `timestamptz` | default `now()` |

## How it's written + read

- **Write** — `recordLoopFirstObserved(admin)` in [[../libraries/control-tower]] runs at the **top of `runControlTowerMonitor`** (the write path, before the snapshot), upserting `{loop_id, kind}` for every `kind:'cron'` registry loop with `onConflict:'loop_id', ignoreDuplicates:true`. So a row is inserted on first sight and its `first_observed_at` is preserved forever after. **Never written in the READ-ONLY `buildControlTowerSnapshot`** the dashboard calls.
- **Read** — `buildControlTowerSnapshot` selects the whole table into a `loop_id → now - first_observed_at` map and passes each cron's value into `evalCron` as `firstObservedAgeMs`.

## Gotchas

- **Absent ⇒ amber, never red.** A loop with no row yet (the write path hasn't stamped it) yields `firstObservedAgeMs = null`, and `evalCron` only fires `registered_not_firing` when **both** `monitorUptimeMs` and `firstObservedAgeMs` are non-null and their `min` exceeds the window. Unknown age is conservative — stay amber.
- **One-time grace after deploy.** First deploy stamps every existing cron with `first_observed_at ≈ now`, so genuinely-dead registered crons won't re-page until a full window (~26h) has elapsed since the deploy. Intended — conservative, retention-safe posture.
- **Crons only.** Only `kind:'cron'` loops are stamped; the `registered_not_firing` check is cron-only (workers/agent-kinds/inline-agents have other liveness checks).

## Migration

`supabase/migrations/20260629120000_control_tower_loop_registry.sql` · apply: `scripts/apply-control-tower-loop-registry-migration.ts`

## Related

[[../specs/control-tower-registered-not-firing-new-cron-grace]] · [[../specs/control-tower]] · [[loop_heartbeats]] · [[loop_alerts]] · [[../inngest/control-tower-monitor]] · [[../libraries/control-tower]]
