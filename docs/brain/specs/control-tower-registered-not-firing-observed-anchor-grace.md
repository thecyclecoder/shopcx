# Control Tower: anchor registered_not_firing grace to first-observed-in-snapshot, not just hand-edited registeredAt

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts (firstscheduledfiringms to max with first_observed_at) + new supabase/migrations/*_monitored_loops_first_seen.sql (loop_id pk, first_seen_at timestamptz default now()) + buildcontroltowersnapshot upsert on each tick (on-conflict-do-nothing, best-effort) + unit test in monitor.test.ts covering the fleet-spend-governor case (registeredat early-midnight, first_observed_at recent → grace holds amber).::monitor-false-positive`
**Repair-signature:** `loop:fleet-spend-governor`

Make the registered_not_firing grace robust to authoring mistakes in `registeredAt`. A short-cadence cron (e.g. `10,40 * * * *`, window 90 min) shipped late in the day with `registeredAt: '2026-06-25T00:00:00Z'` (midnight UTC convention) false-pages the instant it merges, hours before its first valid post-deploy Inngest tick. Add a deploy-surviving DB-persisted 'first observed' timestamp per loop ID, upserted by the watchdog on every tick (on-conflict-do-nothing). Compute the grace anchor as `MAX(registeredAt, first_observed_at)` before resolving the first scheduled firing — so a freshly-shipped cron always gets its full first-window grace regardless of how generously the author wrote `registeredAt`. Preserves the original registered_not_firing semantics for genuinely-dead long-registered crons (both anchors are old → grace still expires → red).

## Problem (from Control Tower signature `loop:fleet-spend-governor`)
fleet-spend-governor (cron `10,40 * * * *`, livenessWindowMs=90 min) merged at 2026-06-25T20:42:24Z (commit fd88d67c). The cron file (`src/lib/inngest/fleet-spend-governor.ts`) emits `emitCronHeartbeat` correctly and is exported in `src/lib/inngest/registered-functions.ts` (line 270). Its registry entry sets `registeredAt: '2026-06-25T00:00:00Z'` (registry.ts:496). At 2026-06-25T21:00:04Z the loop-alerts watchdog fired `registered_not_firing` against it — 18 min after merge, 10 min BEFORE the next scheduled `10,40 * * * *` tick post-deploy (21:10 UTC). The grace in `firstScheduledFiringMs` (monitor.ts:257) anchors on the first firing at-or-after `registeredAt` = 2026-06-25T00:10:00Z, so `sinceFirstFiringMs ≈ 20h50m` >> 90 min window → grace skipped; `monitorUptimeMs > 2d > 90 min` → red. The two prior grace fixes (control-tower-registered-not-firing-newcron-grace, control-tower-cron-grace-uses-next-firing-after-registration) close the in-day boundary case but rely on `registeredAt` being roughly accurate — they don't catch this case where the author wrote a 20-hours-early midnight stamp.

**Likely target:** `src/lib/control-tower/monitor.ts (firstScheduledFiringMs to MAX with first_observed_at) + new supabase/migrations/*_monitored_loops_first_seen.sql (loop_id PK, first_seen_at timestamptz default now()) + buildControlTowerSnapshot upsert on each tick (on-conflict-do-nothing, best-effort) + unit test in monitor.test.ts covering the fleet-spend-governor case (registeredAt early-midnight, first_observed_at recent → grace holds amber).`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:fleet-spend-governor`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:fleet-spend-governor` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
