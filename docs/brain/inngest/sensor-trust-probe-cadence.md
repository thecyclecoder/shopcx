# inngest/sensor-trust-probe-cadence

The daily cadence cron + per-workspace sweep that enqueues the [[../libraries/media-buyer__cold-scaler-arming-gate]] sensor-trust-probe box lane ([[../specs/cold-scaler-arming-decides-on-evidence-not-absence]] Phase 1 — the missing dispatcher for the sensor-trust arm of the cold-scaler arming gate). `runSensorTrustProbe` already exists and has a box lane, but no job was ever enqueued — the [[../tables/media_buyer_sensor_trust]] table stayed empty and the arming gate's trust precondition could never be satisfied. Once daily it finds every workspace with ≥1 active [[../tables/media_buyer_test_cohorts]] row, fans out one event per workspace, and the per-workspace handler inserts one [[../tables/agent_jobs]] row `kind='sensor-trust-probe'` — the box worker's `runSensorTrustProbeJob` lane runs the sensor and writes [[../tables/media_buyer_sensor_trust]] rows.

**File:** `src/lib/inngest/sensor-trust-probe-cadence.ts` · sensor logic in `scripts/builder-worker.ts` (`runSensorTrustProbeJob` lane imports and calls `runSensorTrustProbe`)

## Functions

### `sensor-trust-probe-cron`
- **Trigger:** cron `0 12 * * *` (daily at 12:00 UTC)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads every workspace with ≥1 active [[../tables/media_buyer_test_cohorts]] row, fans out one `growth/sensor-trust-probe-sweep` event per distinct workspace. End-of-run heartbeat via `emitCronHeartbeat("sensor-trust-probe-cron", { ok:true, produced:{workspaces}, detail })`.
- **Returns** `{ workspaces }` (count fanned out).

### `sensor-trust-probe-sweep`
- **Trigger:** event `growth/sensor-trust-probe-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** calls `dispatchSensorTrustProbe(admin, workspace_id)` inside `step.run` to insert one [[../tables/agent_jobs]] row for the workspace with `kind='sensor-trust-probe'`, `spec_slug` set to the stable `sensorTrustProbeSpecSlug()` value. The box worker's lane picks it up and runs `runSensorTrustProbe(admin, workspaceId)`.
- **Returns** `{ status: "complete", evaluated, dispatched }`.

### `SENSOR_TRUST_PROBE_SPEC_SLUG`
- **Constant:** `"sensor-trust-probe:workspace"`
- **What it is:** Stable workspace-scoped `agent_jobs.spec_slug` for the sensor-trust-probe job. The column is `NOT NULL`, so an omitted value blocks the insert. One workspace runs one probe per cron tick, so a single per-workspace slug is the durable bucket for the `agent_jobs_slug_idx (workspace_id, spec_slug, ...)` Roadmap rollups.

### `sensorTrustProbeSpecSlug()`
- **Signature:** `function sensorTrustProbeSpecSlug(): string`
- **What it does:** Returns the stable slug `"sensor-trust-probe:workspace"` — helper form parallel to [[./media-buyer-grade]] `mediaBuyerGradeSpecSlug`.

### `dispatchSensorTrustProbe(admin, workspaceId, nowMs?)`
- **Signature:** `async function dispatchSensorTrustProbe(admin: Admin, workspaceId: string, nowMs?: number): Promise<DispatchSensorTrustProbeResult>`
- **What it does:** Pure per-workspace sweep extracted from the Inngest handler. Checks if the workspace has ≥1 active `media_buyer_test_cohorts` row; if not, returns `{ evaluated: 0, dispatched: 0 }`. If active, checks for a recent `kind='sensor-trust-probe'` job in the last 24h. If found, returns `{ evaluated: 1, dispatched: 0 }` (idempotent). Otherwise inserts ONE workspace-scoped `agent_jobs` row with stable `spec_slug` and returns `{ evaluated: 1, dispatched: 1 }`.
- **Returns** `{ evaluated, dispatched }`.

### `findSensorTrustProbeWorkspaces(admin)`
- **Signature:** `async function findSensorTrustProbeWorkspaces(admin: Admin): Promise<string[]>`
- **What it does:** Queries distinct `workspace_id` from `media_buyer_test_cohorts` where `is_active=true` — the cron's fan-out set.
- **Returns** list of unique workspace IDs.

## Idempotency

The dispatcher is idempotent within 24 hours — a same-day re-fire of the cron (manual or Inngest retry) checks `agent_jobs.created_at` and returns `{ dispatched: 0 }` if a job already enqueued. The next calendar day permits a fresh job. The sensor's own writes to [[../tables/media_buyer_sensor_trust]] are idempotent via the unique index on `(workspace_id, snapshot_date)` — a same-day re-run upserts in place.

## North-star invariant

The sensor-trust probe is a **supervised observation tool** ([[../operational-rules]] § North star) — it observes workspace-level trends in [[../tables/media_buyer_test_cohorts]] snapshot quality and writes read-only [[../tables/media_buyer_sensor_trust]] scores. The [[../libraries/media-buyer__cold-scaler-arming-gate]] gate reads these scores to make authorization decisions; the gate is the supervisor that owns the decision.

## Downstream events sent

- `growth/sensor-trust-probe-sweep` (one per workspace with ≥1 active test cohort, from the cron's fan-out)

Downstream side effect is a `kind='sensor-trust-probe'` [[../tables/agent_jobs]] insert per fan-out. The box worker's `runSensorTrustProbeJob` lane runs `runSensorTrustProbe`, which UPSERTs one row per snapshot_date into [[../tables/media_buyer_sensor_trust]].

## Tables written

- [[../tables/agent_jobs]] (one `kind='sensor-trust-probe'` row per sweep per workspace)
- [[../tables/media_buyer_sensor_trust]] (upsert one row per workspace per snapshot_date from the box lane)
- [[../tables/loop_heartbeats]] (cron's end-of-run beat)

## Tables read (not written)

- [[../tables/media_buyer_test_cohorts]] (active workspace discovery)
- [[../tables/agent_jobs]] (idempotency check — existing recent job within 24h)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs: 30*HOUR`, matching the 1.2× jitter grace for a daily cadence) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/media-buyer__cold-scaler-arming-gate]] · [[../tables/media_buyer_sensor_trust]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/agent_jobs]] · [[cold-scaler-cac-ltv-cadence]] · [[../specs/cold-scaler-arming-decides-on-evidence-not-absence]] · [[../functions/growth]]
