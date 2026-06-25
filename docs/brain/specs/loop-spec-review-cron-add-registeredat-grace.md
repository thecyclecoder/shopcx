# Add registeredAt to spec-review-cron monitor tile so first-tick window is graced

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/registry.ts::monitor-false-positive`
**Repair-signature:** `loop:spec-review-cron`

Add the missing `registeredAt` field to the spec-review-cron entry in `src/lib/control-tower/registry.ts` so the watchdog's newcron-grace path applies and the tile sits amber `awaiting first run` until the cron actually beats, instead of red-paging on day 1 because the watchdog has been up longer than the cron's window.

## Problem (from Control Tower signature `loop:spec-review-cron`)
The auto-proposed monitor entry at `src/lib/control-tower/registry.ts:471-479` for `spec-review-cron` was shipped without a `registeredAt` field. The watchdog's grace logic in `src/lib/control-tower/monitor.ts:475` calls `firstScheduledFiringMs(loop)`, which returns null when `loop.registeredAt` is unset (`monitor.ts:258`). With no grace, the next branch (`monitor.ts:483`) red-pages the loop because `monitorUptimeMs > window` (watchdog has been up 2 days, window is 1 hour). The cron itself shipped only ~21 minutes before the alert fired (registered with Inngest at 2026-06-25 15:39 UTC, monitor entry at 15:56 UTC, alert opened at 16:00 UTC) — well within its 15-min cadence + 45-min grace, and likely before Vercel had even re-synced /api/inngest to activate the schedule. Sibling auto-proposed entries (e.g. `acquisition-research-cadence-cron` at line 495 with `registeredAt: "2026-06-25T14:30:03.155Z"`) carry the field; this one is the outlier. Fix: add `registeredAt: "2026-06-25T15:56:34Z"` (the merge time of PR #645) to the spec-review-cron entry. Verify by running the monitor: tile should report `awaiting first run — first scheduled firing N min ago (within 1h cadence+grace)` (amber) until the cron actually beats, then flip green.

**Likely target:** `src/lib/control-tower/registry.ts`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:spec-review-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:spec-review-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
