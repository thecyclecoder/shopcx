# inngest/control-tower-monitor

The Control Tower watchdog ([[../specs/control-tower]] Phase 1 + Phase 2). Every ~15 min it evaluates every registered autonomous loop, opens a de-duped alert per red loop (paging owners), and auto-resolves on recovery. The single cron that makes "a loop went silent" (P1) **and** "a loop ran but silently did nothing/wrong" (P2 output assertions) visible instead of caught-by-luck.

**File:** `src/lib/inngest/control-tower-monitor.ts` · logic in [[../libraries/control-tower]] (`src/lib/control-tower/monitor.ts`)

## Functions

### `control-tower-monitor`
- **Trigger:** cron `*/15 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** calls `runControlTowerMonitor()` — builds the read-only snapshot (`buildControlTowerSnapshot`, shared with the dashboard) over every loop in the registry (`src/lib/control-tower/registry.ts`), then:
  - **LIVENESS** (the box worker) — [[../tables/worker_heartbeats]] `last_poll_at` fresh within the window **and** `running_sha` not behind the deployed SHA (`VERCEL_GIT_COMMIT_SHA`) longer than the grace window (self-update stuck). The behind-too-long check anchors its elapsed measurement to when drift began (the timestamp of the first commit past the running SHA, fetched from GitHub's compare API) rather than worker uptime ([[../specs/control-tower-box-behind-elapsed-anchored-to-drift-not-uptim]] Phase 1) — so a fresh commit landing on a long-lived worker stays green/amber for the full grace period instead of false-firing just because the worker has been up longer than the grace. Stale / `needs_attention` / behind-too-long → red.
  - **CRON FRESHNESS + NEVER-FIRED** — each registered cron's latest [[../tables/loop_heartbeats]] beat within its `livenessWindowMs` (cadence + grace). Stale → red ("cron X hasn't run in Yh"). **Never-fired keys off whether the loop has EVER beaten, not 0-since-deploy** ([[../specs/control-tower-complete-coverage]] Phase 2, accuracy-fixed by [[../specs/control-tower-monitor-accuracy]] Phase 1; ever-beaten is now PRESENCE in the lateral-join `control_tower_loop_beats` read — [[../specs/control-tower-loop-beats-rpc-perf]]): a cron with **any** historical beat is being invoked → at most a freshness alert, never `never_fired`. Only a cron with **0 beats in all of history** whose deploy has been live longer than its window (`deployRefAgeMs`: the box worker's `started_at` once its `running_sha` matches `VERCEL_GIT_COMMIT_SHA`) is **red `never_fired`** ("registered but has never run — Inngest not invoking it"); a genuinely-fresh cron (or unknown deploy age) stays **amber "awaiting first run"**. Closes the gap where this very cron sat amber-forever for days because a deploy never re-synced Inngest. The cron + agent-kind beats come from the `control_tower_loop_beats` RPC (lateral-join per-loop read; replaced the global 600-beat window that false-flagged low-frequency crons + 500-ed, then the per-row `count(*) OVER` body that re-introduced the full-table sort → statement-timeout 500s — [[../specs/control-tower-loop-beats-rpc-perf]]).
  - **COVERAGE SELF-AUDIT (Phase 2)** — `buildCoverageAudit()` ([[../libraries/control-tower-self-audit]]) diffs every cron `createFunction` in the serve route against the registry (unregistered → amber tiles) and against what Inngest Cloud has registered (the deploy-didn't-re-sync gap). Folded into the snapshot's amber count + logged here (greppable); amber, not a page.
  - **STUCK JOBS** — any [[../tables/agent_jobs]] row `queued`/`claimed`/`building`/`queued_resume` for an agent-kind past that kind's `stuckThresholdMs` → red. A genuinely-idle lane is **green** (no false positives). When the box worker is stale (see `isWorkerUnavailable` in [[../libraries/control-tower]]), `queued` and `queued_resume` rows are suppressed from the stuck check — they are waiting on the worker to recover, not a lane-specific defect. `building` and `claimed` jobs still trip red: they represent in-flight work the worker already claimed, a genuine lane failure. Once the worker recovers, full stuck detection resumes with a grace window from `workerStartedAt` ({{worker-restart clamp}}).
  - **OUTPUT ASSERTIONS (Phase 2)** — for a loop with an `outputAssertion`, a read-only state-check catches the Goodhart case the freshness check can't: the loop ran (fresh beat, green on P1) but silently did nothing/wrong. Layered on top — only escalates green/amber → red (a P1 red stays). Three: **escalation-idle** (`triage-escalations-cron`: the OLDEST open routine-escalated [[../tables/tickets]] has waited past the cadence grace [keyed off its `escalated_at`, not the last job's age — the cron only enqueues when work exists, so the last job legitimately goes stale across quiet stretches] AND no `triage-escalations` [[../tables/agent_jobs]] was created since it escalated → `reason='idle_while_work'`), **spec-test-persisted** (`spec-test-cron`: latest beat reports `enqueued>0` but no `spec-test` job landed since → `reason='false_success'`), **renewal-integrity** (`internal-subscription-renewal-cron`: active internal [[../tables/subscriptions]] overdue, `next_billing_date` before today UTC → `reason='renewal_integrity'`).
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
