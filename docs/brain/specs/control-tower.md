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
- **Liveness:** stop the box worker (or let `last_poll_at` age past the window) → within a monitor cycle, a red tile + an owner Slack alert "box worker stale since {t}"; restart → next beat auto-resolves it.
- **Idle-while-work:** leave a routine-escalated ticket with no triage job past the cadence → alert "triage idle while 1 ticket waits". (Re-validates the exact 3h-ticket gap.)
- **False-success:** force a run that reports produced>0 but persists 0 (the scorecard class) → alert "X reported N, persisted 0", red tile — not a silent green.
- **Cron freshness / stuck jobs:** skip a cron tick / leave a job building past threshold → respective alerts. Healthy state → all green, no alerts, no noise (assertions don't false-positive on a genuinely-idle-but-fine loop, e.g. no escalations to triage = green, not red).

## Phase 1 — heartbeats + liveness + alerting + dashboard ⏳
`loop_heartbeats` table + the registry + heartbeat emits in the box worker & each cron/agent runner + the `control-tower-monitor` cron doing **liveness + cron-freshness + stuck-jobs** checks + owner Slack alerting (de-duped, auto-resolving) + the Control Tower dashboard. Brain: new `loop_heartbeats` table page + `control-tower-monitor` inngest page + [[../dashboard]] (Developer → Control Tower) + [[../operational-rules]] (register-or-it's-incomplete rule).

## Phase 2 — output assertions (false-success + idle-while-work) ⏳
The per-loop **expected-output assertions** — idle-while-work (escalation cron), false-success (produced-but-not-persisted: spec-test, iteration scorecards, renewals), renewal integrity — wired into the monitor. This is the Goodhart-catching layer; P1 catches "loop went silent", P2 catches "loop ran but silently did nothing/wrong".
