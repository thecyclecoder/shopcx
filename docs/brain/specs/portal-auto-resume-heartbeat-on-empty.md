# portal-auto-resume-cron: emit Control Tower heartbeat on the no-work path ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/portal-auto-resume.ts::real-bug`
**Repair-signature:** `loop:portal-auto-resume-cron`

Make portal-auto-resume-cron emit its end-of-run Control Tower heartbeat on every run, including the common case where there are no past-due paused subscriptions to resume, so the cron_freshness monitor stops mis-firing on a healthy loop.

## Problem (from Control Tower signature `loop:portal-auto-resume-cron`)
In src/lib/inngest/portal-auto-resume.ts, portalAutoResumeCron returns early at `if (subs.length === 0) return { status: "no_subs_to_resume" }` (lines 55-57), bypassing the emit-heartbeat step.run (lines 110-113) that calls emitCronHeartbeat("portal-auto-resume-cron", …). On quiet hours loop_heartbeats never gets a fresh ran_at, so the 2h freshness assertion (registry livenessWindowMs: 2*HOUR) flips the tile red even though the cron ran successfully every hour (observed: last beat 2026-06-22T08:15:03Z, then 6 quiet hours → alert at 15:00).

**Likely target:** `src/lib/inngest/portal-auto-resume.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:portal-auto-resume-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:portal-auto-resume-cron` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
