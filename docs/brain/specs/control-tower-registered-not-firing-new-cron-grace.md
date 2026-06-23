# Grace registered_not_firing for newly-added crons (anchor to first-observed, not watchdog uptime) 🚧

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:storefront-lever-decay-cron`

Stop the Control Tower registered_not_firing assertion from paging on a healthy, just-added cron that has not yet reached its first scheduled tick. Anchor the not-firing grace window to when the monitor first observed THIS loop registered, instead of the watchdog's own total uptime, so a newly-deployed cron always gets a full cadence+grace window before it can flip red.

## Problem (from Control Tower signature `loop:storefront-lever-decay-cron`)
The registered_not_firing guard in evalCron (src/lib/control-tower/monitor.ts:311) trips when everBeatCount===0 && monitorUptimeMs > window. monitorUptimeMs is the oldest control-tower-monitor beat → now (monitor.ts:853-868) — the watchdog's continuous uptime, NOT how long the implicated cron has existed. storefront-lever-decay-cron was registered with Inngest on 2026-06-22 19:07 UTC and runs '0 13 * * *', so its first tick is 2026-06-23 13:00 UTC, yet the alert opened 2026-06-23 04:00 UTC (9h before any fire was possible). Because the watchdog had been up >1d (predating the cron), monitorUptimeMs > the loop's 26h window even though the cron was ~9h old, producing a false registered_not_firing page on a healthy loop. Fix: persist a per-loop first_observed_at when the monitor first sees a loop id in the registry, and gate registered_not_firing on min(monitorUptimeMs, now - first_observed_at) > window (keep the deploy-surviving, retention-conservative posture; null/unknown ⇒ stay amber). This eliminates the new-cron false positive while still catching long-registered crons whose Inngest schedule genuinely isn't active.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** new `control_tower_loop_registry` table (`supabase/migrations/20260629120000_control_tower_loop_registry.sql` · apply `scripts/apply-control-tower-loop-registry-migration.ts`) persists a per-loop `first_observed_at` (insert-if-absent, never moved). `runControlTowerMonitor` → `recordLoopFirstObserved` stamps every `kind:'cron'` loop on first sight; `buildControlTowerSnapshot` reads it into a `firstObservedAgeByLoop` map and passes each cron's `firstObservedAgeMs` into `evalCron`, which now gates `registered_not_firing` on `min(monitorUptimeMs, firstObservedAgeMs) > window` (either null/unknown ⇒ stay amber). A just-added cron's small first-observed age keeps it amber through its first cadence; a long-registered dead cron still pages. Brain: [[../tables/control_tower_loop_registry]] + updated [[../libraries/control-tower]] + [[../inngest/control-tower-monitor]]. `npx tsc --noEmit` clean. **Migration not yet applied to prod** (no box creds — needs approval to run the apply script).

## Verification
- Re-trigger the originating condition (signature `loop:storefront-lever-decay-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:storefront-lever-decay-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
