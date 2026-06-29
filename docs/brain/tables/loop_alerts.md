# loop_alerts

The Control Tower's de-duped incident log ([[../specs/control-tower]] Phase 1). The [[../inngest/control-tower-monitor]] cron opens **one OPEN alert per loop** when a registered loop goes red (liveness / cron-freshness / stuck-jobs violation), pages the owners on first sight, and **auto-resolves** the alert the moment the loop goes healthy again. The [[../dashboard/control-tower]] dashboard renders the open alert on the loop's tile.

**Global infra, not workspace-scoped** (same as [[loop_heartbeats]] / [[worker_heartbeats]]). RLS: any authenticated user reads; service role writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `loop_id` | `text` | the violating loop (registry id) — at most **one** `status='open'` row per `loop_id`. The KPI-drift writer ([[../inngest/platform-director-cron]] `audit-platform-scorecard`) sets this to the `signature` value so the existing partial unique index dedupes a non-registry incident too |
| `kind` | `text?` | the loop kind (`worker`｜`cron`｜`agent-kind`) — KPI-drift incidents use `kpi-drift` |
| `reason` | `text` | which check fired: `liveness` ｜ `cron_freshness` ｜ `stuck_jobs` ｜ `kpi_drift` |
| `detail` | `text` | the human-readable violation ("Cron X hasn't run in 4h…") — refreshed each tick while open |
| `status` | `text` | `open` (default) ｜ `resolved` · CHECK-constrained |
| `owner` | `text?` | the org-chart function that owns the incident (`platform` for KPI-drift); legacy registry alerts leave this NULL (the loop's own `owner` lives in [[../specs/control-tower]]'s in-code registry, not the row) — added in [[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 5 |
| `signature` | `text?` | the stable de-dupe key for non-loop incidents — KPI-drift sets `kpi_drift:<metric>:<cadence>` (and stamps `loop_id` to the same value so the partial unique index enforces "one open per signature"); legacy registry alerts leave this NULL — added in [[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 5 |
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
- **KPI-drift writer is separate from the monitor.** The `audit-platform-scorecard` step on [[../inngest/platform-director-cron]] writes its own `kpi_drift:<metric>:<cadence>` rows (`owner='platform'`, `signature` stamped, `loop_id` = signature for the partial-unique-index dedupe). The [[../libraries/control-tower]] monitor iterates only the in-code `MONITORED_LOOPS` registry, so it never touches a kpi-drift row — the KPI writer is the sole opener/resolver of its own signatures. The downstream platform-director reconciler reads ALL open rows by table SELECT (`status='open'`), so kpi-drift rows still flow into the open-backlog surface naturally.
- **Grading-starvation writer (fix-starved-grading).** The `emit-grading-liveness` step on [[../inngest/platform-director-cron]] writes a `grading_starved:director-decision-grading` row (`kind='grading-starved'`, `reason='grading_starved'`, `owner='platform'`, `loop_id`=signature) when the director + worker grade sweeps are STARVED for **≥2 consecutive sweeps** (`considered>0` but `graded==0` across both layers) — and auto-resolves it the moment grading flows again. Like the KPI-drift writer, it's self-managed (the monitor never touches it) and rides the partial-unique-index dedupe. It closes the silent-starvation gap where a concluded-but-ungradeable status (e.g. a build stuck `merged` outside the grader's terminal set) let grading sit dead while the cron heartbeat stayed green.

## Migration

`supabase/migrations/20260622120000_control_tower.sql` (this table + [[loop_heartbeats]] + RLS) · apply: `scripts/apply-control-tower-migration.ts`

`supabase/migrations/20260727120000_kpi_audit_log_and_loop_alerts_owner_signature.sql` ([[kpi_audit_log]] + `owner` / `signature` columns) · apply: `scripts/apply-kpi-audit-log-migration.ts`

## Related

[[../specs/control-tower]] · [[loop_heartbeats]] · [[worker_heartbeats]] · [[../inngest/control-tower-monitor]] · [[../libraries/control-tower]] · [[../libraries/notify-ops-alert]] · [[../dashboard/control-tower]] · [[../libraries/deploy-guardian]] · [[deploy_watches]]
