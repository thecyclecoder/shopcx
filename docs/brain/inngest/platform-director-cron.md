# inngest/platform-director-cron

The **standing cadence** for the box-hosted **Platform/DevOps Director** ([[../specs/platform-director-agent]], M5 [[../specs/director-loop-grading]] Phase 1). The director already runs **event-driven** — a `platform-director` [[../tables/agent_jobs]] row is enqueued when a Platform approval is routed to it ([[../specs/approval-routing-engine]]). What this adds: a **reliable beat** so escorting approved goals through their milestones + watching the platform happen even when no approval happens to arrive. The box has no internal ticker, so (exactly like [[triage-escalations]] / [[spec-test-cron]]) an Inngest cron is the trigger; **this cron does NO reasoning** — it is purely the enqueue. Mirrors [[daily-analysis-report-cron]]'s daily cron shape.

**File:** `src/lib/inngest/platform-director-cron.ts` (registered in `src/lib/inngest/registered-functions.ts` → served by `src/app/api/inngest/route.ts`)

## Functions

### `platform-director-cron`
- **Trigger:** cron `15 12 * * *` (daily at 12:15 UTC — offset from the other crons)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each **build-console workspace** — any workspace that uses the agent-jobs queue (has at least one [[../tables/agent_jobs]] row, mirrors [[spec-test-cron]]) — it inserts one `queued` `agent_jobs` row `kind='platform-director'`. The box claims it on its platform-director lane (`scripts/builder-worker.ts` → `runPlatformDirectorJob`) and runs the standing pass on Max — escort approved goals through their unblocked milestones, watch [[../dashboard/control-tower]] health, and report up.

## Dedupe

It does **not** enqueue a second job for a workspace that already has an in-flight `platform-director` job (`status` ∈ `queued｜queued_resume｜building｜claimed`) — one standing pass per workspace at a time, never a daily pileup.

## Monitored

Registered in `MONITORED_LOOPS` (`src/lib/control-tower/registry.ts`, `owner: platform`, `livenessWindowMs: 26h`, `registeredAt` for the first-tick grace) so a dead cadence is visible on `/dashboard/developer/control-tower` and can't silently die — the [[../specs/coverage-auto-register-agent]] contract. Emits a `loop_heartbeats` beat (`loop_id='platform-director-cron'`) at end-of-run via `emitCronHeartbeat`.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box.

## Tables written

- [[../tables/agent_jobs]] (inserts the `platform-director` job)
- [[../tables/loop_heartbeats]] (end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (build-console workspace scan + in-flight dedupe)

---

[[../README]] · [[../integrations/inngest]] · [[../specs/director-loop-grading]] · [[../../CLAUDE]]
