# inngest/approval-enqueue-director

The **reactive Inngest function** that fires on every Platform-routed `needs_approval` insert and immediately enqueues Ada's platform-director decision job ([[../specs/ada-reacts-to-approvals-immediately-never-sits]] Phase 1). The **sub-minute reactor** behind Ada's approve-fast-or-escalate-fast SLO.

**Why it exists:** The box Platform director's standing pass (`platform-director-cron`) runs every 5 min; a `needs_approval` that lands between beats can sit unprocessed for up to 5 min + processing delay (observed: ~1h stall when the cron backed off to hourly due to `platformHasPendingWork` omitting the `needs_approval` signal). This function removes that latency: on a `platform/approval-needed` event (fired from `scripts/builder-worker.ts` `update()` on every `needs_approval` transition), we route-check + insert exactly one `platform-director` decision job for the target **within seconds** (dedup on `target_job_id`). The 5-min standing-pass cron remains the **gated backstop** (dropped events, cold workspaces).

**File:** `src/lib/inngest/approval-enqueue-director.ts` (registered in `src/lib/inngest/registered-functions.ts`)

## Trigger

`platform/approval-needed` event (fired from `scripts/builder-worker.ts` `update()` on each `agent_jobs` transition to `status='needs_approval'`). Payload: `{ workspace_id, target_job_id }` — the ID of the job whose `status` just became `needs_approval`.

## What it does

1. **Load the target job** — read the `agent_jobs` row by `target_job_id`. Not found → skip (may have already been claimed/completed).
2. **Route-check** — verify the target routes to Platform via [[../libraries/approval-router]] `buildOrgChartGraph` + `loadAutonomyMap` — runs the SAME routing logic [[../libraries/platform-director]] `reactiveEnqueuePlatformDirectorForTarget` enforces.
3. **Enqueue decision job** — if routing confirms Platform, call `reactiveEnqueuePlatformDirectorForTarget` to insert exactly one `kind='platform-director'` [[../tables/agent_jobs]] row with `target_job_id` set. The dedup on `target_job_id` ensures multiple events for the same target (retries, duplicate fires) still produce only one decision job.
4. **Emit reactive heartbeat** — `emitReactiveHeartbeat('approval-enqueue-director', { ok, produced, durationMs })` in a `try/finally` so a thrown run still beats with `ok:false`. Part of the node-completeness trio ([[../CLAUDE.md]] hard rule).

**Return:** `{ status: 'complete' | 'skipped', enqueued: boolean, reason: string }` — consumed by Inngest for logging.

## Deduplication + idempotency

**On `target_job_id`:** The decision job dedup key is `target_job_id`, so multiple `platform/approval-needed` events for the same target (network retries, Inngest double-fire) produce at most one decision job. If the target is already in a later state (`in_progress` / `completed` / `merged` / etc.), the check `target.status !== 'needs_approval'` returns `target-status:<actual>` and enqueues nothing.

**On concurrent events:** Concurrency `{ limit: 1, key: 'event.data.workspace_id' }` mirrors [[build-on-eligible]] — one approval-enqueue check per workspace at a time. A burst of `needs_approval` transitions in the same workspace are serialized into a single ordered chain, preventing race conditions on the dedupe.

## Node completeness trio

Part of the [[../CLAUDE.md]] hard rule ("A node without a switch + heartbeat + owner is incomplete"):

1. **Owner:** `platform` (via `MONITORED_LOOPS` row in [[../control-tower/registry]]).
2. **Kill-switch ancestry:** inherits from `director:platform` (parentIdForOwner in the registry — the reactive function can be disabled by toggling Platform's kill-switch).
3. **Heartbeat:** `emitReactiveHeartbeat` in a `try/finally` — every run emits a beat (ok/failure), visible on the Platform card.

## Downstream coordination

**Standing-pass backstop:** [[../inngest/platform-director-cron]] remains the per-5-min gated sweep. The newly-added `needs_approval` EXISTS check in [[../libraries/platform-director]] `platformHasPendingWork` (Phase 1) ensures the cron stays on `*/5` cadence whenever a routed approval is sitting — no double-enqueue risk since both paths dedup on `target_job_id`.

**Approval routing:** Only fires for Platform-routed approvals (confirmed by `buildOrgChartGraph` + `loadAutonomyMap` check). Other-function routes are untouched.

---

[[../README]] · [[../inngest/platform-director-cron]] · [[../libraries/platform-director]] · [[../specs/ada-reacts-to-approvals-immediately-never-sits]] · [[../../CLAUDE]]
