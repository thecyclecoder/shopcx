# Control Tower cron grace clock should start at next scheduled firing, not at registeredAt

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:security-dep-watch`

Tighten the Control Tower `registered_not_firing` assertion so a healthy cron registered just AFTER its daily firing time isn't false-paged hours before its first real chance to fire. The grace clock should start at the cron's first scheduled firing at-or-after `registeredAt`, not at `registeredAt` itself.

## Problem (from Control Tower signature `loop:security-dep-watch`)
evalCron in src/lib/control-tower/monitor.ts (lines 322-336) treats `now - registeredAt > livenessWindowMs (26h)` as proof that Inngest isn't invoking a cron with 0 beats. That's wrong when `registeredAt` falls AFTER the cron's daily tick: security-dep-watch (cadence `0 4 * * *`) had `registeredAt: 2026-06-24T00:00:00Z` but its deploy landed at 2026-06-24T04:08 UTC, missing that day's 04:00 tick. The watchdog paged registered_not_firing at 2026-06-25T02:00:01Z — exactly 26h after registeredAt — even though the very first valid scheduled firing wasn't until 2026-06-25T04:00:00Z, 2 hours LATER. Any cron whose `registeredAt` is set conservatively to start-of-UTC-day (the pattern visible across daily-digest-cron, platform-director-cron, etc.) is vulnerable to the same false page whenever the actual deploy slips past the cron's hour-of-day. Parse the loop entry's cron expression (already in `expectedCadence`) once at module load, compute `firstScheduledFiringAt-or-after(registeredAt)`, and gate the registered_not_firing red on `now - firstScheduledFiring > grace` instead — preserving the same red for genuinely-dead schedules but removing the boundary false-page.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:security-dep-watch`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:security-dep-watch` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
