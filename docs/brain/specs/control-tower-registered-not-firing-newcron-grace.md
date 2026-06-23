# Control Tower: grace registered_not_firing for newly-added crons (per-loop registration age) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:storefront-experiments-refresh-cron`

Stop the registered_not_firing cron assertion from red-paging a freshly-added long-cadence cron before it has had a chance to fire its first scheduled tick. The assertion must key off how long THIS cron has been registered, not the unrelated watchdog uptime, so a just-shipped daily cron is graced exactly like the deploy-anchored never_fired check already graces it.

## Problem (from Control Tower signature `loop:storefront-experiments-refresh-cron`)
In evalCron (src/lib/control-tower/monitor.ts:311) the registered_not_firing red fires when everBeatCount===0 AND monitorUptimeMs > window. monitorUptimeMs is derived from the OLDEST control-tower-monitor beat (snapshot builder ~line 859-868) — the watchdog's own continuous uptime — which is independent of when a given cron was added to the registry. storefront-experiments-refresh-cron (daily '0 12 * * *', 26h window) was added to registered-functions.ts on 2026-06-22 17:45 UTC; the alert opened 2026-06-23 04:00 UTC, ~8h BEFORE its first scheduled noon-UTC tick. Because the watchdog had already been running >26h, the assertion tripped immediately even though the cron is healthy and simply awaiting its first run. The code comment at monitor.ts:306-308 assumes a just-added cron 'fires within its first cadence before this trips', which is false for any cron registered AFTER the watchdog passed its window. Fix: persist/derive a per-loop first-observed-in-registry timestamp and require (now - firstObservedAt) > window (deploy-surviving, unlike deployAgeMs) IN ADDITION to monitorUptimeMs > window before firing registered_not_firing; a cron observed in the registry for less than a full window stays amber ('awaiting first run').

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:storefront-experiments-refresh-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:storefront-experiments-refresh-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
