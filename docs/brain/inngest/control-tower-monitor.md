# inngest/control-tower-monitor

The Control Tower watchdog ([[../specs/control-tower]] Phase 1). Every ~15 min it evaluates every registered autonomous loop, opens a de-duped alert per red loop (paging owners), and auto-resolves on recovery. The single cron that makes "a loop went silent" visible instead of caught-by-luck.

**File:** `src/lib/inngest/control-tower-monitor.ts` · logic in [[../libraries/control-tower]] (`src/lib/control-tower/monitor.ts`)

## Functions

### `control-tower-monitor`
- **Trigger:** cron `*/15 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** calls `runControlTowerMonitor()` — builds the read-only snapshot (`buildControlTowerSnapshot`, shared with the dashboard) over every loop in the registry (`src/lib/control-tower/registry.ts`), then:
  - **LIVENESS** (the box worker) — [[../tables/worker_heartbeats]] `last_poll_at` fresh within the window **and** `running_sha` not behind the deployed SHA (`VERCEL_GIT_COMMIT_SHA`) longer than the grace window (self-update stuck). Stale / `needs_attention` / behind-too-long → red.
  - **CRON FRESHNESS** — each registered cron's latest [[../tables/loop_heartbeats]] beat within its `livenessWindowMs` (cadence + grace). Stale → red ("cron X hasn't run in Yh"). No beat ever → amber (awaiting first run).
  - **STUCK JOBS** — any [[../tables/agent_jobs]] row `queued`/`claimed`/`building`/`queued_resume` for an agent-kind past that kind's `stuckThresholdMs` → red. A genuinely-idle lane is **green** (no false positives).
  - **INLINE AI AGENTS** — for each `ai:<name>` agent (`ai:ticket-analyzer`, `ai:journey-delivery`, `ai:fraud-detector`) over its `windowMs`: **silent-while-work-exists** (upstream work existed — closed AI tickets / journey sessions / web orders — but 0 *successful* in-window beats → red "silent while N awaited") and **error-rate** (>`errorRateThreshold` of in-window runs errored, or ≥`consecutiveFailureLimit` in a row → red "N/M runs errored"). A genuinely-idle agent (no work in the window) is **green**.
  - On a **newly** red loop → insert a [[../tables/loop_alerts]] open incident + **page owners** via `notifyOpsAlert` ([[../libraries/notify-ops-alert]]) Slack DM. While still red → bump `last_seen_at`, no re-page (de-dupe). On recovery (green/amber) → resolve the open alert.
- **Self-monitoring:** emits its **own** `control-tower-monitor` heartbeat at the end (via `emitCronHeartbeat`), and is itself in the registry — so a dead watchdog shows as a stale cron tile too.
- **Returns** `{ evaluated, red, amber, green, opened, resolved }`.

## Downstream events sent

_None._ Side effects are DB writes ([[../tables/loop_alerts]]) + Slack DMs.

## Tables written

- [[../tables/loop_alerts]] (open / bump / resolve incidents)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/worker_heartbeats]] (box liveness)
- [[../tables/loop_heartbeats]] (cron + agent-kind + inline-agent freshness/history)
- [[../tables/agent_jobs]] (stuck-job detection)
- [[../tables/tickets]] · `journey_sessions` · [[../tables/orders]] (inline-agent upstream work counts)
- [[../tables/workspace_members]] (owners/admins to page)

## Register-or-it's-incomplete

A new cron / worker / agent-kind / inline AI agent is **incomplete without a Control Tower registry entry** (see [[../operational-rules]]). Add the loop to `src/lib/control-tower/registry.ts` and emit a heartbeat at the end of its run, or the monitor can't see it. Inline AI agents (any server-side model-call-that-acts) were added retroactively in [[../specs/control-tower-agent-coverage]].

---

[[../README]] · [[../integrations/inngest]] · [[../specs/control-tower]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]] · [[../../CLAUDE]]
