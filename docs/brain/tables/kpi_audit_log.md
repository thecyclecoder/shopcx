# kpi_audit_log

The Platform Department Scorecard's **drift trend store** ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 5). One row per `(workspace_id, metric_key, cadence, snapshot_date)` per audit run: the [[../inngest/platform-director-cron]] `audit-platform-scorecard` step runs [[../libraries/kpi-review]] `auditAllKpis` on the same beat that took the snapshot, re-derives every advertised KPI from the raw tables, and persists the drift verdict here so the ≥2-consecutive-over-tolerance check is queryable from a single bounded read.

Without this table the audit's verdict would be in-memory only and the alerter would have no honest way to distinguish "a transient write that landed between snapshot + re-derive" from "the engine is actually wrong." A single over-tolerance row is **logged but not alerted** (self-healing on timing noise); two in a row opens a `loop_alerts` `kpi_drift:<metric>:<cadence>` incident with `owner='platform'`.

Written by [[../inngest/platform-director-cron]] only. Read by the same step (the 2-row alerter lookback) and, in the future, a `kpi-drift` trend chart on the [[../dashboard/control-tower]] surface.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `metric_key` | `text` | — | the audited KPI (matches [[platform_scorecard_snapshots]].`metric_key`) |
| `cadence` | `text` | — | CHECK ∈ `daily` ｜ `weekly` ｜ `monthly` |
| `snapshot_date` | `date` | — | the `snapshot_date` of the persisted row that was diffed (same value the engine wrote) |
| `snapshot_value` | `numeric` | — | the value the engine persisted into [[platform_scorecard_snapshots]] |
| `ground_truth_value` | `numeric` | — | the value the SAME `MetricDef.compute` produces NOW from the raw tables ([[../libraries/kpi-review]] uses `computeScorecardValuesOnly`) |
| `drift` | `numeric` | — | `ground_truth − snapshot` in the metric's native unit (signed) |
| `drift_pct` | `numeric` | ✓ | `|drift / snapshot_value|`; NULL when `snapshot_value` = 0 (division by zero — drift is reported but the percentage is undefined) |
| `within_tolerance` | `boolean` | — | `drift_pct ≤ toleranceFor(metric_key)` (or, when `drift_pct` is null, `drift = 0`). The alerter reads this column — two `false`s in a row opens a `loop_alerts` row |
| `audited_at` | `timestamptz` | — | when the audit ran · default `now()` |
| `created_at` | `timestamptz` | — | default `now()` |

**Indexes:**
- `kpi_audit_log_ws_metric_cadence_idx` — `(workspace_id, metric_key, cadence, audited_at desc)` — the alerter's bounded lookback read (latest 2 rows).
- `kpi_audit_log_ws_metric_idx` — `(workspace_id, metric_key, audited_at desc)` — per-metric trend chart.

## Foreign keys

- `workspace_id` → [[workspaces]].id (`on delete cascade`).

## The alerter contract

After a row is inserted, the audit step reads the last 2 rows for `(workspace_id, metric_key, cadence)` ordered by `audited_at desc`. Four cases:

| Latest 2 audits | Action |
|---|---|
| Both `within_tolerance=false` | Open (or refresh) `loop_alerts` row `loop_id='kpi_drift:<metric>:<cadence>'`, `owner='platform'`, `kind='kpi-audit'`, `reason='kpi_drift'` |
| Latest is `within_tolerance=true`, alert is open | Auto-resolve the alert (`status='resolved', resolved_at=now()`) |
| Latest is `within_tolerance=false`, prior is `true` (or absent) | Log only — transient, self-healing |
| Both `true` | No-op |

The de-dupe spine is [[loop_alerts]]'s existing `loop_alerts_one_open_per_loop` partial unique index on `(loop_id) where status='open'` — a racing double-open lands as a `23505`, which is logged and skipped.

## Tolerance overrides

The tolerance the `within_tolerance` column reflects is keyed by `metric_key` in [[../libraries/kpi-review]] `TOLERANCE_OVERRIDES`. Strict counts hold to `DEFAULT_TOLERANCE = 0.005` (0.5%); median / aggregate / current-state metrics tolerate `0.05` (5%) because they pick up writes that land between snapshot + re-derive.

## Gotchas

- **The audit step runs AFTER the daily/weekly/monthly snapshot steps in the same cron tick.** Order matters: a re-derive run BEFORE the snapshot would have no row to diff against. The step ordering is enforced inline in [[../inngest/platform-director-cron]] — don't reorder.
- **`drift_pct` can be NULL legitimately** (snapshot = 0). The alerter check is `within_tolerance=false`, not `drift_pct > X` — the boolean already handles the null case (it's `true` iff `drift=0` in that branch).
- **The audit step is best-effort + idempotent.** A row-insert failure is logged, not thrown; the cron continues. The next beat re-audits.

## Migration

`supabase/migrations/20260727120000_kpi_audit_log_and_loop_alerts_owner.sql` (this table + [[loop_alerts]].owner + RLS) · apply: `scripts/apply-kpi-audit-log-migration.ts`

## Related

[[../specs/devops-kpi-review-sdk-and-data-fix]] · [[../libraries/kpi-review]] · [[../libraries/platform-scorecard]] · [[platform_scorecard_snapshots]] · [[loop_alerts]] · [[../inngest/platform-director-cron]] · [[../dashboard/control-tower]]
