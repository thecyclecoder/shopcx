# control_tower_loop_beats must not full-scan 5.2M rows — index-backed latest-N read ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower-monitor-accuracy]] + [[../specs/control-tower-beats-read-failure-guard]] + [[../specs/control-tower]] · **Repair-signature:** `loop:portal-action-healer` · **Verdict:** monitor-false-positive

Eliminate the root cause behind the recurring false never_fired cascade: the control_tower_loop_beats RPC times out (8.1s, statement-timeout) on a 5.22M-row loop_heartbeats table, returning null and blinding the Control Tower to every cron beat. Rewrite it as an index-friendly read so the snapshot always gets real beats and the never_fired/cron_freshness checks evaluate on live data. Monitor-only — Postgres RPC + the snapshot's call site, no product code.

## Problem (from Control Tower signature `loop:portal-action-healer`)
control_tower_loop_beats (supabase/migrations/20260622160000_control_tower_loop_beats.sql) computes row_number() and count(*) over (partition by loop_id) across the full loop_heartbeats table (kind not in inline-agent/reactive) BEFORE filtering rn<=p_history_limit. With 5.22M rows the window aggregation can't ride the (loop_id, ran_at desc) index and is forced into a full scan+sort, measured at 8101ms → 'canceling statement due to statement timeout' → returns null. buildControlTowerSnapshot (monitor.ts:588) destructures only {data: beats}, dropping the error, so beats=null → countByLoop empty → evalCron(loop, latest=null, deployAgeMs, everBeatCount=0) trips everBeatCount===0 && deployAgeMs>window → false never_fired. This was just proven against loop:portal-action-healer (44 healthy prod beats, last 14:15:00) and previously against meta-capi-dispatch-cron, slack-roadmap-notify, ticket-unsnooze. Rewrite the RPC to fetch the latest p_history_limit beats per loop via a lateral join over distinct loop_ids (index-backed) and return presence (count>0 — all evalCron reads via everBeatCount===0) instead of an unbounded count(*) over (partition); add any supporting index/retention as needed. Gate: the RPC returns in well under the statement timeout against the live 5.2M-row table.

**Likely target:** `supabase/migrations/* (rewrite public.control_tower_loop_beats RPC) + src/lib/control-tower/monitor.ts:588 (capture the RPC error)`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:portal-action-healer`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:portal-action-healer` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
