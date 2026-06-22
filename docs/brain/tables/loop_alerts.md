# loop_alerts

The Control Tower's de-duped incident log ([[../specs/control-tower]] Phase 1). The [[../inngest/control-tower-monitor]] cron opens **one OPEN alert per loop** when a registered loop goes red (liveness / cron-freshness / stuck-jobs violation), pages the owners on first sight, and **auto-resolves** the alert the moment the loop goes healthy again. The [[../dashboard/control-tower]] dashboard renders the open alert on the loop's tile.

**Global infra, not workspace-scoped** (same as [[loop_heartbeats]] / [[worker_heartbeats]]). RLS: any authenticated user reads; service role writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `loop_id` | `text` | the violating loop (registry id) — at most **one** `status='open'` row per `loop_id` |
| `kind` | `text?` | the loop kind (`worker`｜`cron`｜`agent-kind`) |
| `reason` | `text` | which check fired: `liveness` ｜ `cron_freshness` ｜ `stuck_jobs` |
| `detail` | `text` | the human-readable violation ("Cron X hasn't run in 4h…") — refreshed each tick while open |
| `status` | `text` | `open` (default) ｜ `resolved` · CHECK-constrained |
| `opened_at` | `timestamptz` | when the incident first opened · default `now()` |
| `last_seen_at` | `timestamptz` | bumped each monitor tick the violation persists · default `now()` |
| `resolved_at` | `timestamptz?` | when a healthy evaluation auto-resolved it |
| `created_at` | `timestamptz` | default `now()` |

## De-dupe spine

`loop_alerts_one_open_per_loop` — a **partial unique index** on `(loop_id) where status = 'open'`. The monitor's contract:

- **First red sight** (no open alert) → `insert` + **page owners** (`notifyOpsAlert` Slack DM to every Slack-connected workspace's owners/admins). One page per incident, never per tick.
- **Still red** (open alert exists) → bump `last_seen_at` + refresh `reason`/`detail`. **No re-page** (de-dupe).
- **Recovered** (loop green/amber) → `update status='resolved', resolved_at=now()`.

The unique index is the belt-and-suspenders against a racing double-open (the cron is concurrency-1, so it's rare); the monitor treats a `23505` on insert as "already open" and skips the page.

## Gotchas

- **Amber doesn't open an alert.** Only a **red** loop (an active liveness/freshness/stuck violation) opens/keeps an alert; amber (cron awaiting first run, worker mid self-update, a not-ok cron beat) is informational and **resolves** any existing open alert. Alerts exist iff there's an active page-worthy violation.
- **Paging fans out per workspace.** `notifyOpsAlert` is called for every distinct workspace that has an owner/admin with a `slack_user_id` — in practice the one Superfoods workspace. Best-effort; a Slack outage never breaks the monitor.

## Migration

`supabase/migrations/20260622120000_control_tower.sql` (this table + [[loop_heartbeats]] + RLS) · apply: `scripts/apply-control-tower-migration.ts`

## Related

[[../specs/control-tower]] · [[loop_heartbeats]] · [[worker_heartbeats]] · [[../inngest/control-tower-monitor]] · [[../libraries/control-tower]] · [[../libraries/notify-ops-alert]] · [[../dashboard/control-tower]]
