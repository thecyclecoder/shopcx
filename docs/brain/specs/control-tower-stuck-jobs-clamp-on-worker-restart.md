# Control Tower stuck-jobs clamps queued age to worker restart

**Owner:** [[../functions/platform]] · **Parent:** extends [[../dashboard/control-tower]] + [[control-tower-monitor-accuracy]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:agent:spec-test`

Stop the agent-kind stuck-jobs assertion from paging the CEO right after a worker restart when a backlog accumulated during the worker-down window. Today the assertion uses created_at/updated_at as the 'stuck since' floor — but if the worker was offline, no lane could possibly have claimed earlier than worker_heartbeats.started_at, so counting that gap as 'stuck' is worker-fault attribution that isn't true. Clamp the queued-job floor to the worker boot boundary so a freshly-restarted box gets a fair drain window before the same backlog is re-raised as red.

## Problem (from Control Tower signature `loop:agent:spec-test`)
Loop tile agent:spec-test went RED at 2026-06-25T12:00 with 'stuck_jobs: 8 spec-test job(s) stuck in queued past 60m (oldest 1h, job c9974936)'. Probing agent_jobs shows the 11 spec-test rows in the batch were all created at 2026-06-25T10:45 by the regression-backlog-reconciliation Phase 1 sweep (scripts/builder-worker.ts:2512). worker_heartbeats row for id='box' shows status='healthy', running_sha=20dce6c6 (matches main), started_at=2026-06-25T11:45:23Z, active_builds=7 — i.e. the box was offline from before 10:45 until 11:45, then immediately began draining the spec-test queue at concurrency 3 (claimed_at stamps at 11:45/11:50/11:54/11:55/11:57/11:58; one row already completed by 12:00). Neither the Claude-down breaker nor the worker_controls drain flag was involved — the jobs stayed in 'queued' (parkClaudeDependentJobs would have flipped them to 'blocked_on_dependency'). evalAgentKind (monitor.ts:492) and jobStuckSince (monitor.ts:305) only look at created_at/updated_at and ignore worker boot state, so a worker restart that straddled a batch enqueue is unconditionally reported as 'lane is stuck' even though the queue is actively draining post-restart.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:agent:spec-test`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:agent:spec-test` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
