# Control Tower — make every autonomous loop watch itself ⏳

**Owner:** [[../functions/platform]] · **Parent:** the supervisable-autonomy north star ([[../operational-rules]] § North star). The observability layer that lets us *trust* the autonomy we've built — the gap between a powerful system and a governed one.

We now run a dozen autonomous loops (the box worker, ~8 agent kinds, ~6+ Inngest crons, the renewal engine). This week three of them **failed silently** and we caught each by luck, not design:
- `triage-escalations-cron` was **idle** — nothing escalated to the routine, ever — found only because a ticket sat 3h.
- `computeScorecards` **swallowed an upsert error** and reported "7 written / 0 persisted" — caught only when it tripped a regression.
- duplicate parallel builds + a stale escalated ticket lingered with no signal.

These are **Goodhart failures**: a tool reports its proxy succeeded ("run completed") while the real objective silently failed ("0 rows persisted", "0 enqueued while work exists"). The fix is to make each loop **emit a heartbeat + assert its expected output**, and **page the owner on silence or false-success** — instead of waiting for a stuck ticket or a lucky regression.

## Model
- **`loop_heartbeats`** (new table): every autonomous loop writes one row at the **end of each run** — `loop_id, ran_at, ok (bool), produced (int|jsonb), detail, duration_ms`. Crons, the box worker, and each agent-kind runner emit it.
- **A loop registry** (code config): each monitored loop declares `{ id, kind: cron｜worker｜agent-kind, expected_cadence, liveness_window, output_assertion }`. The assertion is a small function: given recent state, is this loop *actually doing its job*?
- **`control-tower-monitor` cron** (every ~15 min): for each registered loop, evaluate **(a) liveness** — heartbeat within `liveness_window`? worker `running_sha` fresh? — and **(b) output assertion** — did it produce what it should? On violation → open an **alert** + **page the owner** (Slack DM to owners, the existing notify path; optional email) with the loop id + what's wrong + last-good time. De-dupe alerts (one open incident per loop until it recovers; auto-resolve on next healthy beat).
- **Control Tower dashboard** (`/dashboard/developer/control-tower`, owner-gated): every loop as a green/amber/red tile — last ran, last produced, status, open alerts, recent history. The single "is the machine healthy?" screen.

## First inhabitants (the exact failure classes that bit us)
- **Box worker liveness** — `worker_heartbeats.last_poll_at` stale > N min, or `running_sha` behind `origin/main` for too long → alert.
- **Escalation cron not idle-while-work-exists** — if routine-escalated tickets exist (`escalated_at` set, `escalated_to` null, open) AND no `triage-escalations` job was enqueued within the cadence → alert ("triage idle while N tickets wait"). *(the 3h-ticket incident)*
- **No false-success** — a run that reports `produced=N` but a state check shows 0 persisted (spec-test run rows == built; `iteration_run.scorecard_rows` == `iteration_scorecards_daily` delta; renewal cron processed due subs) → alert. *(the swallowed-upsert incident)*
- **Cron freshness** — each Inngest cron (`spec-test-cron`, `triage-escalations-cron`, `migration-audit-retry`, `migration-integrity-sweep`, `internal-subscription-renewals`, …) beat within its window → else alert ("cron X hasn't run in Yh").
- **Stuck jobs** — any `agent_jobs` row `queued`/`building` > threshold (per kind) → alert ("job stuck").
- **Renewal integrity** — due internal subs with `next_billing_date <= today` not advanced after the renewal window → alert.

## Guardrail / principle
This is the **objective-owner's window** from the north star: every autonomous tool optimizes a bounded proxy; the Control Tower is where the CEO sees whether the proxy is still serving the real objective, and it **escalates (pages) rather than silently trusting**. New autonomous loops must register a heartbeat + assertion as part of shipping (add to the "Hard rule" in [[../operational-rules]]: a new cron/worker/agent-kind is incomplete without a Control Tower entry).

## Verification

### Phase 1 (shipped) — liveness + cron-freshness + stuck-jobs + dashboard
- On `/dashboard/developer/control-tower` (as the workspace **owner**), expect a green/amber/red tile for every registered loop grouped Worker · Crons · Agent lanes, each showing last-ran / last-produced / a history strip → and a non-owner sees only an "owner-only" notice. (The API `GET /api/developer/control-tower` returns 403 for a non-owner.)
- On the DB, after the next `control-tower-monitor` tick (≤15 min) with everything healthy, expect **all tiles green/amber, zero `loop_alerts` rows with `status='open'`**, and a fresh `control-tower-monitor` row in `loop_heartbeats`. A genuinely-idle agent lane (no queued jobs) and a cron with no work to enqueue are **green**, not red (no false positives).
- **Liveness:** stop the box worker (or let `worker_heartbeats.last_poll_at` age past 5 min) → within a monitor cycle expect the **Box build worker** tile red ("stale — last poll … ago") + one `loop_alerts` open row (`reason='liveness'`) + an owner Slack DM "Control Tower: Box build worker 🔴". Restart the worker → next monitor tick auto-resolves the alert (tile green).
- **Cron freshness:** for any monitored cron, let its latest `loop_heartbeats` beat age past its window (e.g. pause `migration-audit-retry-cron` > 40 min) → expect that cron's tile red ("hasn't run in …") + an open `loop_alerts` row (`reason='cron_freshness'`) + one Slack page. Resume → auto-resolves.
- **Stuck jobs:** leave an `agent_jobs` row `building` past its per-kind threshold (e.g. a `build` job > 2 h) → expect the matching **Agent — build** tile red ("N jobs stuck …") + an open `loop_alerts` row (`reason='stuck_jobs'`) + one Slack page. Clear/finish the job → auto-resolves.
- **De-dupe:** while a violation persists, expect the open `loop_alerts` row's `last_seen_at` to bump each tick but **no repeat Slack DM** (one page per incident); the partial unique index `loop_alerts_one_open_per_loop` enforces ≤1 open row per loop.
- **Self-monitoring:** disable/skip `control-tower-monitor` for > 45 min → its own tile goes red on the next manual snapshot load (a dead watchdog is visible too).

### Phase 2 (planned ⏳) — output assertions
- **Idle-while-work:** leave a routine-escalated ticket with no triage job past the cadence → alert "triage idle while 1 ticket waits". (Re-validates the exact 3h-ticket gap.)
- **False-success:** force a run that reports produced>0 but persists 0 (the scorecard class) → alert "X reported N, persisted 0", red tile — not a silent green.

## Phase 1 — heartbeats + liveness + alerting + dashboard ✅
`loop_heartbeats` + `loop_alerts` tables + the registry (`src/lib/control-tower/registry.ts`) + heartbeat emits in the box worker (`agent:<kind>` beats in `launch()`) & each monitored cron + the `control-tower-monitor` cron (every 15 min) doing **liveness + cron-freshness + stuck-jobs** checks + owner Slack alerting (de-duped via a partial unique index, auto-resolving) + the owner-gated Control Tower dashboard at `/dashboard/developer/control-tower`. Brain: new [[../tables/loop_heartbeats]] + [[../tables/loop_alerts]] table pages + [[../inngest/control-tower-monitor]] inngest page + [[../libraries/control-tower]] + [[../dashboard/control-tower]] (Developer → Control Tower) + [[../operational-rules]] (register-or-it's-incomplete rule).

Liveness uses the existing [[../tables/worker_heartbeats]] for the box (its ~5s poll beat) and `loop_heartbeats` for crons + agent kinds. SHA-behind uses `VERCEL_GIT_COMMIT_SHA` as the origin/main proxy and only pages after a 30-min grace (no deploy-time false positives).

## Phase 2 — output assertions (false-success + idle-while-work) ⏳
The per-loop **expected-output assertions** — idle-while-work (escalation cron), false-success (produced-but-not-persisted: spec-test, iteration scorecards, renewals), renewal integrity — wired into the monitor. This is the Goodhart-catching layer; P1 catches "loop went silent", P2 catches "loop ran but silently did nothing/wrong".
