# Control Tower: a failed beats read must not false-fire never_fired ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower-loop-beats-scope-feed]] + [[../specs/control-tower-monitor-accuracy]] + [[../specs/control-tower]] · **Repair-signature:** `loop:meta-capi-dispatch-cron` · **Verdict:** monitor-false-positive

When the control_tower_loop_beats RPC errors or returns null, buildControlTowerSnapshot currently treats it as 0 beats ever for every cron/agent-kind loop and false-fires never_fired reds (paging owners) on healthy loops. Capture the RPC error and, when the beats read failed, suppress the never_fired and cron_freshness reds so a transient/timed-out read stays conservative (amber) instead of paging — the same way the existing deployAgeMs==null guard keeps a missing deploy-age reference from false-alarming.

## Problem (from Control Tower signature `loop:meta-capi-dispatch-cron`)
Loop flipped red never_fired at 2026-06-22T12:45:12Z but the cron is healthy: prod loop_heartbeats has 564 beats for meta-capi-dispatch-cron, beating every minute (ok:true) incl. 12:50/12:51/12:52. never_fired requires everBeatCount===0 (monitor.ts:236-248), sourced from the control_tower_loop_beats RPC (monitor.ts:597), which is 500-ing in prod under a statement timeout scanning ~4.19M feed rows (sig supabase-logs:bc3c30231145bed6, 12:30:13Z). monitor.ts:588-597 keeps only {data: beats} and drops the error; on a 500 beats=null → line 613 iterates nothing → countByLoop empty for every cron → evalCron sees everBeatCount=0,latest=null → false never_fired + page. The short 10m window makes this cron trip first.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** `buildControlTowerSnapshot` (`src/lib/control-tower/monitor.ts`) now captures the `control_tower_loop_beats` RPC `error` and computes `beatsReadFailed = beatsError != null || beats == null`. `evalCron` takes the flag and short-circuits to amber `"beats read unavailable — status unknown"` before the `!latest`/stale branches, suppressing both the `never_fired` and `cron_freshness` reds when the read failed — the same conservative posture as the existing `deployAgeMs==null` guard. A genuinely-empty system returns `[]` (≠ null) so a real never-fired cron still pages. Brain page [[../libraries/control-tower]] updated; `npx tsc --noEmit` clean. Output assertions are unaffected — they read independent `assertionInputs`, not the beats RPC.

## Verification
- Re-trigger the originating condition (signature `loop:meta-capi-dispatch-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:meta-capi-dispatch-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
