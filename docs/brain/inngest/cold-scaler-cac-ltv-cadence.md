# inngest/cold-scaler-cac-ltv-cadence

The weekly cadence cron + per-workspace sweep that enqueues the [[../libraries/media-buyer__cold-scaler-arming-gate]] cold-scaler CAC:LTV sensor box lane ([[../specs/cold-scaler-arming-decides-on-evidence-not-absence]] Phase 2 — the missing dispatcher for the cold-scaler CAC:LTV arm of the cold-scaler arming gate). `runColdScalerCacLtvSensor` is fully written but unreferenced outside a comment — no cron ever enqueued it, so [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] stayed empty and the gate had no CAC:LTV ratio to compare to its target. Once weekly (Monday 12:00 UTC) it finds every workspace with ≥1 active [[../tables/media_buyer_cold_scaler_cohorts]] row, fans out one event per workspace, and the per-workspace handler inserts one [[../tables/agent_jobs]] row `kind='cold-scaler-cac-ltv'` — the box worker's lane runs the sensor and UPSERTs one [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] row per ISO week per active cohort.

**File:** `src/lib/inngest/cold-scaler-cac-ltv-cadence.ts` · sensor logic in `scripts/builder-worker.ts` (`runColdScalerCacLtvJob` lane) and `src/lib/media-buyer/cold-scaler-cac-ltv-sensor.ts` (imports and calls `runColdScalerCacLtvSensor`)

## Functions

### `cold-scaler-cac-ltv-cron`
- **Trigger:** cron `0 12 * * 1` (weekly on Monday at 12:00 UTC — the start of a fresh ISO week)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads every workspace with ≥1 active [[../tables/media_buyer_cold_scaler_cohorts]] row, fans out one `growth/cold-scaler-cac-ltv-sweep` event per distinct workspace. End-of-run heartbeat via `emitCronHeartbeat("cold-scaler-cac-ltv-cron", { ok:true, produced:{workspaces}, detail })`.
- **Returns** `{ workspaces }` (count fanned out).

### `cold-scaler-cac-ltv-sweep`
- **Trigger:** event `growth/cold-scaler-cac-ltv-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** calls `dispatchColdScalerCacLtv(admin, workspace_id)` inside `step.run` to insert one [[../tables/agent_jobs]] row for the workspace with `kind='cold-scaler-cac-ltv'`, `spec_slug` set to the stable `coldScalerCacLtvSpecSlug()` value. The box worker's lane picks it up and runs `runColdScalerCacLtvJob`, which enumerates active cohorts and runs `runColdScalerCacLtvSensor` for each, upserting one row per cohort per ISO week.
- **Returns** `{ status: "complete", evaluated, dispatched }`.

### `COLD_SCALER_CAC_LTV_SPEC_SLUG`
- **Constant:** `"cold-scaler-cac-ltv:workspace"`
- **What it is:** Stable workspace-scoped `agent_jobs.spec_slug` for the cold-scaler CAC:LTV sensor job. The column is `NOT NULL`, so an omitted value blocks the insert. One workspace runs one sensor pass per cron tick (which fans over the workspace's active scaler cohorts), so a single per-workspace slug is the durable bucket for the `agent_jobs_slug_idx (workspace_id, spec_slug, ...)` Roadmap rollups.

### `coldScalerCacLtvSpecSlug()`
- **Signature:** `function coldScalerCacLtvSpecSlug(): string`
- **What it does:** Returns the stable slug `"cold-scaler-cac-ltv:workspace"` — helper form parallel to [[./sensor-trust-probe-cadence]] `sensorTrustProbeSpecSlug`.

### `dispatchColdScalerCacLtv(admin, workspaceId, nowMs?)`
- **Signature:** `async function dispatchColdScalerCacLtv(admin: Admin, workspaceId: string, nowMs?: number): Promise<DispatchColdScalerCacLtvResult>`
- **What it does:** Pure per-workspace sweep extracted from the Inngest handler. Checks if the workspace has ≥1 active `media_buyer_cold_scaler_cohorts` row; if not, returns `{ evaluated: 0, dispatched: 0 }`. If active, checks for a recent `kind='cold-scaler-cac-ltv'` job in the last 7 days. If found, returns `{ evaluated: 1, dispatched: 0 }` (idempotent within the ISO week). Otherwise inserts ONE workspace-scoped `agent_jobs` row with stable `spec_slug` and returns `{ evaluated: 1, dispatched: 1 }`.
- **Returns** `{ evaluated, dispatched }`.

### `findColdScalerCacLtvWorkspaces(admin)`
- **Signature:** `async function findColdScalerCacLtvWorkspaces(admin: Admin): Promise<string[]>`
- **What it does:** Queries distinct `workspace_id` from `media_buyer_cold_scaler_cohorts` where `is_active=true` — the cron's fan-out set.
- **Returns** list of unique workspace IDs.

## Idempotency

The dispatcher is idempotent within 7 days (one ISO week) — a same-week re-fire of the cron (manual or Inngest retry) checks `agent_jobs.created_at` and returns `{ dispatched: 0 }` if a job already enqueued. The following week permits a fresh job. The sensor's own writes to [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] are idempotent via the unique key on `(workspace_id, cold_scaler_cohort_id, iso_week)` — a same-week re-run upserts in place.

## North-star invariant

The cold-scaler CAC:LTV sensor is a **supervised observation tool** ([[../operational-rules]] § North star) — it observes and computes cohort-level CAC:LTV ratios for scaler cohorts and writes read-only [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] snapshots. The [[../libraries/media-buyer__cold-scaler-arming-gate]] gate reads these snapshots to make authorization decisions; the gate is the supervisor that owns the decision.

## Downstream events sent

- `growth/cold-scaler-cac-ltv-sweep` (one per workspace with ≥1 active cold-scaler cohort, from the cron's fan-out)

Downstream side effect is a `kind='cold-scaler-cac-ltv'` [[../tables/agent_jobs]] insert per fan-out. The box worker's `runColdScalerCacLtvJob` lane runs `runColdScalerCacLtvSensor` for each active cohort in the workspace, upserting one row per snapshot into [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] keyed on `(workspace_id, cold_scaler_cohort_id, iso_week)`.

## Tables written

- [[../tables/agent_jobs]] (one `kind='cold-scaler-cac-ltv'` row per sweep per workspace)
- [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] (upsert one row per cohort per iso_week from the box lane)
- [[../tables/loop_heartbeats]] (cron's end-of-run beat)

## Tables read (not written)

- [[../tables/media_buyer_cold_scaler_cohorts]] (active workspace discovery)
- [[../tables/agent_jobs]] (idempotency check — existing recent job within 7d)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs: 9*DAY`, matching the 1.28× jitter grace for a weekly cadence) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/media-buyer__cold-scaler-arming-gate]] · [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] · [[../tables/media_buyer_cold_scaler_cohorts]] · [[../tables/agent_jobs]] · [[sensor-trust-probe-cadence]] · [[../specs/cold-scaler-arming-decides-on-evidence-not-absence]] · [[../functions/growth]]
