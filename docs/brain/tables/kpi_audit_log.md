# kpi_audit_log

The **per-metric drift trend table** written by the `audit-platform-scorecard` step on [[../inngest/platform-director-cron]] ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 5). The standing pass runs [[../libraries/kpi-review]] `auditAllKpis` for every cadence and **upserts one row per `(workspace_id, metric_key, cadence, snapshot_date)`** capturing the persisted snapshot value, the re-derived ground-truth value, the drift, and the `withinTolerance` verdict.

The trend grain is **per snapshot**, not per beat — the cron runs every 5 min but each `(cadence, snapshot_date)` maps to ONE [[platform_scorecard_snapshots]] row, so the upsert refreshes the latest re-audit in place. That lets the cron's persistent-drift check trivially read the latest 2 `snapshot_date` rows per metric to decide whether to open / resolve a `kpi_drift:<metric>:<cadence>` [[loop_alerts]] incident.

Workspace-scoped (the KPI engine is workspace-scoped). RLS: any authenticated user reads (so a future scorecard trend chart can read it client-side); service role writes.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | the workspace whose scorecard is being audited |
| `metric_key` | `text` | — | the audited KPI from the [[../libraries/platform-scorecard]] registry (`worker_grade_rollup`, `error_mttr_hours`, …) |
| `cadence` | `text` | — | CHECK ∈ `daily` ｜ `weekly` ｜ `monthly` |
| `snapshot_date` | `date` | — | the `snapshot_date` of the [[platform_scorecard_snapshots]] row being audited (NOT `now()`) |
| `snapshot_value` | `numeric` | — | the value the engine persisted into [[platform_scorecard_snapshots]] |
| `ground_truth_value` | `numeric` | — | the value the SAME `MetricDef.compute` produced from the raw tables at audit time |
| `drift` | `numeric` | — | `ground_truth_value − snapshot_value` in the metric's native unit |
| `drift_pct` | `numeric` | ✓ | `|drift / snapshot_value|`; null when `snapshot_value` is 0 (divide-by-zero) |
| `within_tolerance` | `boolean` | — | the verdict from [[../libraries/kpi-review]] — `driftPct ≤` the metric's tolerance (or — when `driftPct` is null — `drift === 0`) |
| `unit` | `text` | — | the metric's unit at audit time (mirrors the snapshot row's unit) |
| `audited_at` | `timestamptz` | — | refreshed by the upsert on each re-audit · default `now()` |

**Unique** (`kpi_audit_log_snapshot_unique`): `(workspace_id, metric_key, cadence, snapshot_date)` — the upsert key; one verdict per snapshot.

**Indexes:** `(workspace_id, metric_key, cadence, snapshot_date desc)` — the persistent-drift read pattern (latest 2 snapshot rows per metric). The unique index covers the upsert; no separate snapshot-date lookup index is needed.

## Persistent-drift contract

The cron uses this table to distinguish **transient** drift (timing noise — single snapshot over-tolerance) from **persistent** drift (real divergence — ≥2 consecutive snapshot_dates over-tolerance):

- Latest 2 `snapshot_date` rows for `(ws, metric, cadence)` both `within_tolerance = false` → **open** (or refresh) a `kpi_drift:<metric>:<cadence>` [[loop_alerts]] row.
- Latest snapshot recovers (`within_tolerance = true`) → **resolve** any open `kpi_drift:*` alert.
- A single over-tolerance row is **logged** here but does **NOT** open an alert (self-healing on timing noise).

The open `kpi_drift:*` alert feeds [[../libraries/platform-director]] `reconcileErrorBacklog` (it reads `loop_alerts` directly, no MONITORED_LOOPS registry entry needed) and surfaces on the [[../dashboard/control-tower]] alerts list + the daily watch line.

## Gotchas

- **NOT a per-beat log.** The cron runs every 5 min but the unique constraint dedupes to one row per snapshot. The re-audit refreshes `audited_at` + the values in place so the latest verdict for a snapshot is always the current one.
- **Workspace-scoped, not global.** Unlike [[loop_alerts]] / [[loop_heartbeats]] (global infra), this table is workspace-scoped because [[platform_scorecard_snapshots]] is workspace-scoped.
- **No mutation outside the cron step.** The Inngest `audit-platform-scorecard` step is the sole writer (mirrors the "one writer" invariant for [[platform_scorecard_snapshots]] → [[../libraries/platform-scorecard]]).

## Migration

`supabase/migrations/20260726130000_kpi_audit_log.sql` (table + unique index + trend index + RLS) · apply: `scripts/apply-kpi-audit-log-migration.ts`

## Related

[[../specs/devops-kpi-review-sdk-and-data-fix]] · [[platform_scorecard_snapshots]] · [[loop_alerts]] · [[../libraries/kpi-review]] · [[../libraries/platform-scorecard]] · [[../inngest/platform-director-cron]]
