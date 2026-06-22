# control_tower_loop_beats — scope the scan to monitored kinds (stop the 4M-row 500) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower-monitor-accuracy]] + [[../specs/control-tower]] · **Repair-signature:** `supabase-logs:bc3c30231145bed6` · **Verdict:** real-bug

Stop POST /rest/v1/rpc/control_tower_loop_beats from 500-ing under statement timeout by bounding its scan to the loop kinds the Control Tower monitor actually reads from it, instead of scanning the millions of high-volume feed liveness beats.

## Problem (from Control Tower signature `supabase-logs:bc3c30231145bed6`)
control_tower_loop_beats filters `kind not in ('inline-agent','reactive')` but the dominant kind is 'feed' (4,186,218 live rows, written by recordFeedDelivery on every error-feed delivery; cron=1,574, agent-kind=86). Its row_number/count window functions partition over all ~4.19M unfiltered rows to return ~194, taking ~7-19s and tripping the PostgREST statement timeout → 500 (sig bc3c30231145bed6, 2026-06-22T12:30:13Z). Worsens monotonically as feed beats grow.

**Likely target:** `supabase/migrations (new) replacing public.control_tower_loop_beats — change `where h.kind not in ('inline-agent','reactive')` to `where h.kind in ('cron','agent-kind')`; consumed by src/lib/control-tower/monitor.ts:597`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `supabase-logs:bc3c30231145bed6`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `supabase-logs:bc3c30231145bed6` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
