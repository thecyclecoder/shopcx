# iteration_runs

The Storefront Iteration Engine's **Phase 5** daily-run audit log — one row per
orchestrated pipeline run for one Meta ad account. Records `status`, timing,
per-stage breadcrumbs, the active [[iteration_policies]] version the run ran
under, and any error, so a human (or the future Growth Director) can see every
day what the engine did end-to-end (ingest → attribution → rollups → reconcile →
4a actions → 4b recommendations → 6a execution) without reading logs — the
supervisable-autonomy record for the whole engine. Written by
[[../libraries/meta__iteration-run]] (`startRun`/`finishRun`), driven by the
`meta-iteration-run` Inngest function ([[../inngest/meta-performance]]). Migration
`20260620170000_iteration_runs.sql`. RLS: workspace-member SELECT, service-role
write. See [[../specs/storefront-iteration-engine]] (Phase 5).

**Primary key:** `id`

## Grain

One row per pipeline **execution** (append-only run history). The pipeline
*stages* are each idempotent (they upsert their own tables on stable keys), but
this table is NOT deduped — a re-run is a new row so it's observable. A run owns
the account for its duration via the function's `concurrency: { key:
ad_account_id }`.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `snapshot_date` | `date` | ✓ | the scorecard day the run decided on (null if it failed before rollups) |
| `trigger` | `text` | — | `cron` \| `manual` (CHECK, default `cron`) |
| `status` | `text` | — | `running` \| `complete` \| `failed` (CHECK, default `running`) |
| `policy_active` | `boolean` | — | whether an active policy governed the run (false ⇒ recs only, zero actions) |
| `policy_version_id` | `uuid` | ✓ | → [[iteration_policies]].id the run ran under |
| `stages` | `jsonb` | — | `[{ name, status, ms, ...counts }]` per-stage breadcrumbs (default `[]`) |
| `counts` | `jsonb` | — | run summary: `{ scorecard_rows, actions_decided, escalations, reversals, outcomes_reconciled, recommendations, variant_attribution_coverage, spend_drift_objects }` (default `{}`) |
| `error` | `text` | ✓ | failure message (`status='failed'`) |
| `started_at` | `timestamptz` | — | default `now()` |
| `finished_at` | `timestamptz` | ✓ | stamped on finish |
| `duration_ms` | `int` | ✓ | `finished_at − started_at`, stamped on finish |
| `created_at` | `timestamptz` | — | default `now()` |

## Indexes

- `(workspace_id, meta_ad_account_id, started_at desc)` — the daily run list per account.
- `(status, started_at desc)` — find running/failed runs.
- `(meta_ad_account_id, snapshot_date)` — runs for a given scorecard day.

## Lifecycle

`startRun` inserts `running` → each stage runs as a durable Inngest step,
appending a `StageRecord` → `finishRun` stamps `complete` (with `counts` +
`duration_ms`) or, on a stage throw, `failed` (with `error`) plus a
[[../libraries/notify-ops-alert]] DM to the owners.

## Gotchas

- Append-only — a re-run on the same `snapshot_date` is a NEW row, not an update;
  dedup the pipeline *effects* via the downstream tables' stable keys, not this.
- A `complete` run can still carry stage warnings (e.g. `spend_drift_objects > 0`)
  — read `counts`/`stages`, not just `status`.
- Monetary fields inside `counts` are **cents**.
