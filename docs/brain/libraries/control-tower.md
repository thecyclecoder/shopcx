# libraries/control-tower

The Control Tower module ([[../specs/control-tower]] Phase 1 + Phase 2) — the registry, the heartbeat emit helper, and the monitor/snapshot logic (liveness + cron-freshness + stuck-jobs + Phase 2 output assertions) that powers the [[../inngest/control-tower-monitor]] cron and the [[../dashboard/control-tower]] dashboard.

**Files:** `src/lib/control-tower/registry.ts` · `src/lib/control-tower/heartbeat.ts` · `src/lib/control-tower/monitor.ts`

## `registry.ts` — the loop registry (code config)

The single source of truth for every loop the monitor watches. **Add a row here when you ship a new cron / worker / agent-kind** ([[../operational-rules]] "register-or-it's-incomplete").

- `type LoopKind = "worker" | "cron" | "agent-kind"`
- `type OutputAssertionId = "escalation-idle" | "spec-test-persisted" | "renewal-integrity"` — Phase 2 output assertions (see monitor.ts).
- `interface MonitoredLoop { id, kind, label, description, expectedCadence, livenessWindowMs?, shaGraceMs?, agentKind?, stuckThresholdMs?, outputAssertion? }`
- `MONITORED_LOOPS: MonitoredLoop[]` — the box worker (`box`), 7 crons (each cron's inngest fn id + a cadence-derived `livenessWindowMs`), and 10 agent kinds (`agent:<kind>` + a per-kind `stuckThresholdMs`). Three crons also carry an `outputAssertion`: `triage-escalations-cron` → `escalation-idle`, `spec-test-cron` → `spec-test-persisted`, `internal-subscription-renewal-cron` → `renewal-integrity`.
- `WORKER_BOX_ID = "box"` (matches `scripts/builder-worker.ts`) · `agentLoopId(kind)` → `agent:<kind>`.

## `heartbeat.ts` — end-of-run emit

Best-effort writes of one [[../tables/loop_heartbeats]] row (never throws).

- `emitLoopHeartbeat(loopId, kind, { ok?, produced?, detail?, durationMs? })`
- `emitCronHeartbeat(functionId, …)` — `kind:'cron'`, `loop_id` = the inngest fn id. Called by each monitored cron inside a `step.run("emit-heartbeat", …)` before its return.
- `emitAgentHeartbeat(agentKind, …)` — `kind:'agent-kind'`, `loop_id` = `agent:<kind>`. (The box worker writes its agent beats via its own inline `writeLoopHeartbeat` against its existing admin client, not this helper — same shape.)

## `monitor.ts` — snapshot + monitor

- `buildControlTowerSnapshot(admin?)` → `ControlTowerSnapshot { generatedAt, counts:{green,amber,red}, loops: LoopStatus[] }`. **READ-ONLY**: one batched read of [[../tables/worker_heartbeats]], [[../tables/loop_heartbeats]] (last 600 beats, grouped per loop, ≤10 history each), open [[../tables/loop_alerts]], and active [[../tables/agent_jobs]]; evaluates each loop to a `LoopStatus { color, statusText, lastRanAt, lastProduced, detail, violation, history, openAlert }`. Used **verbatim** by the dashboard API.
- `runControlTowerMonitor()` → `MonitorResult`. Builds the snapshot, then **acts**: opens a de-duped [[../tables/loop_alerts]] incident on each newly-red loop (paging owners via [[../libraries/notify-ops-alert]]), bumps `last_seen_at` while still red (no re-page), and resolves on recovery. Called only by the cron.
- Evaluators: `evalWorker` (liveness + SHA-behind), `evalCron` (freshness), `evalAgentKind` (stuck jobs). Genuinely-idle/healthy → green; a freshly-shipped cron with no beat yet → amber (never a false red).
- **Phase 2 output assertions** (`evalOutputAssertion`, layered on top of the P1 tile — only escalates green/amber → red, a P1 red stays): `fetchAssertionInputs(admin)` adds 4 cheap read-only queries to the snapshot batch — open routine-escalated [[../tables/tickets]] (`escalated_at` set, `escalated_to` null, not closed/archived), the latest `triage-escalations` + `spec-test` [[../tables/agent_jobs]] `created_at`, and active overdue internal [[../tables/subscriptions]] (`next_billing_date` before today UTC). The three assertions: **escalation-idle** (tickets wait + no triage job within the cadence → `reason='idle_while_work'`, "idle while N tickets wait"), **spec-test-persisted** (beat reports `enqueued>0` but no spec-test job landed since → `reason='false_success'`, "reported N enqueued, persisted 0"), **renewal-integrity** (N active internal subs overdue → `reason='renewal_integrity'`). A violation flows through `runControlTowerMonitor` exactly like a P1 red (de-duped alert + page).

## Gotchas

- **SHA-behind needs `VERCEL_GIT_COMMIT_SHA`** (the deployed commit) as the origin/main proxy; unset locally ⇒ the check is skipped (no false positive). It only fires red after `shaGraceMs` (default 30m) so an in-progress deploy / self-update never pages.
- **Agent-kind alert is off [[../tables/agent_jobs]], not the heartbeat** — idle = green. The heartbeat only feeds last-ran/history.

## Callers

[[../inngest/control-tower-monitor]] (`runControlTowerMonitor`) · `src/app/api/developer/control-tower/route.ts` (`buildControlTowerSnapshot`) · the 7 monitored crons + `scripts/builder-worker.ts` (heartbeat emits).

## Related

[[../specs/control-tower]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[../tables/worker_heartbeats]] · [[../inngest/control-tower-monitor]] · [[../dashboard/control-tower]] · [[../operational-rules]]
