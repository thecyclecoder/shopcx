# never_fired must require a TRUSTWORTHY beat read (a failed RPC ≠ 0 beats) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] (hardens [[../specs/control-tower-monitor-accuracy]]; complements [[../specs/control-tower-loop-beats-scope-feed]]) · **Repair-signature:** `loop:slack-roadmap-notify` · **Verdict:** monitor-false-positive

Make the Control Tower never_fired cron check fire only on a trustworthy zero — when the per-loop beat-count read actually succeeded and returned zero — instead of on an absent count caused by a failed/timed-out control_tower_loop_beats RPC. A failed read is unknown, not zero beats ever.

## Problem (from Control Tower signature `loop:slack-roadmap-notify`)
buildControlTowerSnapshot (monitor.ts:597) never inspects the control_tower_loop_beats RPC error; on its current statement-timeout (57014, ~8s scanning ~4.19M feed rows) beats=null, countByLoop is empty, and evalCron gets countByLoop.get(id) ?? 0 = 0, tripping everBeatCount===0 && deployAgeMs>window → false never_fired. Proven false: slack-roadmap-notify has 564 prod beats, last 12:52:03, beating every minute, yet its never_fired alert flaps hourly.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Shipped: `buildControlTowerSnapshot` (monitor.ts) now destructures the `control_tower_loop_beats` RPC `error` and threads a `beatsReadOk` boolean into `evalCron`. The `never_fired` red only fires when `beatsReadOk && everBeatCount === 0` — a failed/timed-out read (no rows → empty `countByLoop`, a false "0 beats" for every loop) is treated as unknown and keeps loops amber instead of false-paging. A failed read logs `console.error`. Brain page `inngest/control-tower-monitor.md` updated. `npx tsc --noEmit` clean.

## Verification
- Re-trigger the originating condition (signature `loop:slack-roadmap-notify`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:slack-roadmap-notify` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
