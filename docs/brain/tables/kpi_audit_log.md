# kpi_audit_log

The **KPI drift trend store** — one row per `(workspace_id, metric_key, cadence, snapshot_date)` recording the persisted [[platform_scorecard_snapshots]] value, the same-window re-derived ground-truth value, the drift, and whether it stayed inside the metric's tolerance band ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 5). Persisted SO the alerter can decide **transient (1 snapshot) vs persistent (≥2 consecutive)** by reading ONE prior row, no window scan.

Written **only** by the `audit-platform-scorecard` step on [[../inngest/platform-director-cron]] (the deployed runtime). The [[../libraries/kpi-review]] SDK remains pure-read; this is its sole audit-log sink. Mirrors [[platform_scorecard_snapshots]]' idempotent-upsert shape one layer up — a same-snapshot re-audit upserts in place, never a duplicate.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `metric_key` | `text` | — | the KPI — matches [[platform_scorecard_snapshots]].metric_key (free text, no CHECK, so a newly-registered KPI needs no migration) |
| `cadence` | `text` | — | CHECK ∈ `daily` \| `weekly` \| `monthly` — which cadence's registry the metric belongs to |
| `snapshot_date` | `date` | — | the as-of day of the [[platform_scorecard_snapshots]] row this audit was diffed against |
| `snapshot_value` | `numeric` | — | the persisted snapshot value · default 0 |
| `ground_truth_value` | `numeric` | — | the same-window re-derived value the SAME `MetricDef.compute` produced at audit time · default 0 |
| `drift` | `numeric` | — | `ground_truth_value − snapshot_value` in the metric's native unit · default 0 |
| `drift_pct` | `numeric` | ✓ | `\|drift / snapshot_value\|`; null when `snapshot_value = 0` (division undefined — the report flags it as `withinTolerance` iff `drift = 0`) |
| `within_tolerance` | `bool` | — | true when drift stayed inside the metric's tolerance band — the alerter reads this to decide transient vs persistent · default `true` |
| `tolerance` | `numeric` | — | the tolerance the verdict was judged against (per-metric override or `DEFAULT_TOLERANCE=0.005`) — recorded so a tolerance change is auditable against past readings · default 0.005 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique** (`kpi_audit_log_key_uniq`): `(workspace_id, metric_key, cadence, snapshot_date)` — the idempotent upsert key; a same-snapshot re-audit UPSERTs in place, never a duplicate.

**Indexes:** `(workspace_id, metric_key, cadence, snapshot_date desc)` — the "previous snapshot" lookup the alerter uses to gate the persistent-drift open.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id (ON DELETE CASCADE).

**In:** _none._

## RLS

Mirrors [[platform_scorecard_snapshots]] / the grade ledgers: any **authenticated** user `SELECT`s (the audit-log surface is owner-gated above the DB), **service role** does all writes (only the cron step writes this table).

## How the alerter reads it

The `audit-platform-scorecard` step on [[../inngest/platform-director-cron]] runs `auditAllKpis` per cadence per workspace, upserts one row per metric here, then for every metric where `within_tolerance = false`:

- Reads the IMMEDIATELY-PREVIOUS row for the same `(workspace_id, metric_key, cadence)` (most recent `snapshot_date` strictly before this one).
- If that prior row was ALSO `within_tolerance = false` → opens (or refreshes) a [[loop_alerts]] row with `loop_id = signature = 'kpi_drift:<metric>:<cadence>'`, `owner='platform'`, `kind='kpi-drift'`, `reason='kpi_drift'`. ≥2 consecutive over-tolerance snapshots ⇒ persistent drift ⇒ page.
- If that prior row was within tolerance (or no prior row exists) → just logged. **Transient timing noise self-heals** on the next pass (concluded repairs land between writes, lane utilization churns in seconds, etc.).

For every metric where `within_tolerance = true` and an open `kpi_drift:<metric>:<cadence>` alert exists → **auto-resolve** it (mirrors the [[../libraries/control-tower]] monitor's recovery path).

## Invariants

- **Display-only proxy, never an objective** ([[../operational-rules]] § North star). The audit log is the trend ledger for drift visibility; nothing reads it as a worker target.
- **Idempotent.** Re-running the audit for the same `snapshot_date` re-upserts the same key — no duplicate rows.
- **One writer.** Only the `audit-platform-scorecard` step on [[../inngest/platform-director-cron]] writes this table; everything else reads.
- **Self-healing.** A single-snapshot over-tolerance reading is logged but does NOT page — the persistent-drift gate (≥2 consecutive) prevents transient timing noise from waking the owner.

## Migration

`supabase/migrations/20260727120000_kpi_audit_log_and_loop_alerts_owner_signature.sql` (this table + the `owner` + `signature` columns on [[loop_alerts]] · RLS) · apply: `scripts/apply-kpi-audit-log-migration.ts`

## Related

[[platform_scorecard_snapshots]] · [[loop_alerts]] · [[../libraries/kpi-review]] · [[../libraries/platform-scorecard]] · [[../inngest/platform-director-cron]] · [[../specs/devops-kpi-review-sdk-and-data-fix]]
