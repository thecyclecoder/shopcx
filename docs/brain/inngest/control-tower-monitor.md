# inngest/control-tower-monitor

The Control Tower watchdog ([[../specs/control-tower]] Phase 1 + Phase 2). Every ~15 min it evaluates every registered autonomous loop, opens a de-duped alert per red loop (paging owners), and auto-resolves on recovery. The single cron that makes "a loop went silent" (P1) **and** "a loop ran but silently did nothing/wrong" (P2 output assertions) visible instead of caught-by-luck.

**File:** `src/lib/inngest/control-tower-monitor.ts` · logic in [[../libraries/control-tower]] (`src/lib/control-tower/monitor.ts`)

## Functions

### `control-tower-monitor`
- **Trigger:** cron `*/15 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** calls `runControlTowerMonitor()` — builds the read-only snapshot (`buildControlTowerSnapshot`, shared with the dashboard) over every loop in the registry (`src/lib/control-tower/registry.ts`), then:
  - **LIVENESS** (the box worker) — [[../tables/worker_heartbeats]] `last_poll_at` fresh within the window **and** `running_sha` not behind the deployed SHA (`VERCEL_GIT_COMMIT_SHA`) longer than the grace window (self-update stuck). Stale / `needs_attention` / behind-too-long → red.
  - **CRON FRESHNESS + NEVER-FIRED** — each registered cron's latest [[../tables/loop_heartbeats]] beat within its `livenessWindowMs` (cadence + grace). Stale → red ("cron X hasn't run in Yh"). **0 beats ever:** distinguishes never-fired-past-grace from awaiting-first-tick ([[../specs/control-tower-complete-coverage]] Phase 2) — if the deploy has been live longer than the cron's window (`deployRefAgeMs`: the box worker's `started_at` once its `running_sha` matches `VERCEL_GIT_COMMIT_SHA`) it's **red `never_fired`** ("registered but has never run — Inngest not invoking it"); a genuinely-fresh cron (or unknown deploy age) stays **amber "awaiting first run"**. Closes the gap where this very cron sat amber-forever for days because a deploy never re-synced Inngest.
  - **COVERAGE SELF-AUDIT (Phase 2)** — `buildCoverageAudit()` ([[../libraries/control-tower-self-audit]]) diffs every cron `createFunction` in the serve route against the registry (unregistered → amber tiles) and against what Inngest Cloud has registered (the deploy-didn't-re-sync gap). Folded into the snapshot's amber count + logged here (greppable); amber, not a page.
  - **STUCK JOBS** — any [[../tables/agent_jobs]] row `queued`/`claimed`/`building`/`queued_resume` for an agent-kind past that kind's `stuckThresholdMs` → red. A genuinely-idle lane is **green** (no false positives).
  - **OUTPUT ASSERTIONS (Phase 2)** — for a loop with an `outputAssertion`, a read-only state-check catches the Goodhart case the freshness check can't: the loop ran (fresh beat, green on P1) but silently did nothing/wrong. Layered on top — only escalates green/amber → red (a P1 red stays). Three: **escalation-idle** (`triage-escalations-cron`: open routine-escalated [[../tables/tickets]] wait but no `triage-escalations` [[../tables/agent_jobs]] enqueued within the cadence → `reason='idle_while_work'`), **spec-test-persisted** (`spec-test-cron`: latest beat reports `enqueued>0` but no `spec-test` job landed since → `reason='false_success'`), **renewal-integrity** (`internal-subscription-renewal-cron`: active internal [[../tables/subscriptions]] overdue, `next_billing_date` before today UTC → `reason='renewal_integrity'`).
  - On a **newly** red loop (liveness, freshness, stuck, **or** output-assertion) → insert a [[../tables/loop_alerts]] open incident + **page owners** via `notifyOpsAlert` ([[../libraries/notify-ops-alert]]) Slack DM. While still red → bump `last_seen_at`, no re-page (de-dupe). On recovery (green/amber) → resolve the open alert.
- **Self-monitoring:** emits its **own** `control-tower-monitor` heartbeat at the end (via `emitCronHeartbeat`), and is itself in the registry — so a dead watchdog shows as a stale cron tile too.
- **Returns** `{ evaluated, red, amber, green, opened, resolved }`.

## Downstream events sent

_None._ Side effects are DB writes ([[../tables/loop_alerts]]) + Slack DMs.

## Tables written

- [[../tables/loop_alerts]] (open / bump / resolve incidents)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/worker_heartbeats]] (box liveness)
- [[../tables/loop_heartbeats]] (cron + agent-kind freshness/history)
- [[../tables/agent_jobs]] (stuck-job detection + Phase 2 escalation/spec-test enqueue checks)
- [[../tables/tickets]] (Phase 2 escalation-idle: routine-escalated tickets waiting)
- [[../tables/subscriptions]] (Phase 2 renewal-integrity: overdue active internal subs)
- [[../tables/workspace_members]] (owners/admins to page)

## Register-or-it's-incomplete

A new cron / worker / agent-kind is **incomplete without a Control Tower registry entry** (see [[../operational-rules]]). Add the loop to `src/lib/control-tower/registry.ts` and emit a heartbeat at the end of its run, or the monitor can't see it. As of [[../specs/control-tower-complete-coverage]] Phase 2 the coverage self-audit ([[../libraries/control-tower-self-audit]]) **detects** a missing cron registry entry automatically (amber "unregistered loop: X") rather than trusting authors. A new cron also needs Inngest to register it — `syncInngestRegistration()` runs on every box-worker restart (i.e. on deploy) so a newly-added `createFunction` registers instead of silently never firing.

---

[[../README]] · [[../integrations/inngest]] · [[../specs/control-tower]] · [[../specs/control-tower-complete-coverage]] · [[../tables/loop_heartbeats]] · [[../tables/loop_alerts]] · [[../libraries/control-tower]] · [[../libraries/control-tower-self-audit]] · [[../dashboard/control-tower]] · [[../../CLAUDE]]
