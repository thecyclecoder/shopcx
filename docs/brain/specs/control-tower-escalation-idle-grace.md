# Control Tower: escalation-idle assertion — grace off oldest-ticket escalated_at, not last-job age ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:triage-escalations-cron`

Stop the escalation-idle output assertion from mis-firing on a healthy triage-escalations-cron during the normal gap between a ticket escalating and the next hourly cron tick. Re-base the idle judgment on how long the oldest routine-escalated ticket has actually been waiting (its escalated_at), with a grace at least as long as the cron's hourly cadence, instead of on the staleness of the last enqueued job (which legitimately goes stale during quiet, work-free stretches).

## Problem (from Control Tower signature `loop:triage-escalations-cron`)
In src/lib/control-tower/monitor.ts the escalation-idle case (monitor.ts:544) fires when escalatedWaiting>0 AND latestTriageJobAt (the created_at of the most-recent triage-escalations agent_job, any status) is older than livenessWindowMs (2h). triage-escalations-cron only inserts a job when escalated work exists, so during a quiet period it correctly enqueues nothing and latestTriageJobAt goes arbitrarily stale. Confirmed in prod: the cron beat healthily hourly with produced.enqueued:0 for 15h, ticket 9f36b9fa escalated at 15:42:33, the alert opened at 15:45:07 (ticket waited ~2.5 min), no in-flight job existed, and the next hourly cron (16:30) would enqueue it — yet the assertion reported 'idle while 1 ticket waits, last enqueue 15h ago' because it keyed off the 15h-old last job rather than the just-now escalation. The assertion must instead read the oldest waiting ticket's escalated_at and only flag when that age exceeds the window (grace ≥ the hourly cadence) AND no triage job was created since the ticket escalated.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:triage-escalations-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:triage-escalations-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
