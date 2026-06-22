# ticket-csat-cron: emit Control Tower heartbeat on idle (no-due) ticks 🚧

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower-complete-coverage]] + [[../specs/control-tower-monitor-accuracy]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/inngest/ticket-csat.ts::real-bug`
**Repair-signature:** `loop:ticket-csat-cron`

Guarantee ticket-csat-cron emits exactly one loop_heartbeats beat on every run, including the common no-due-tickets path, so the cron_freshness watchdog stops flagging a healthy idle cron as stale. Restore the heartbeat.ts contract ('every monitored cron calls this at the END of each run') for this cron.

## Problem (from Control Tower signature `loop:ticket-csat-cron`)
src/lib/inngest/ticket-csat.ts emits its heartbeat only in the trailing step.run('emit-heartbeat') (line ~159), but line 90 ('if (!due.length) return { sent: 0, ... }') returns before that step whenever no tickets are due. Because CSAT eligibility is narrow (closed 48h-7d ago, unstamped, with a customer-facing outbound), most 15-min ticks are idle and exit early, emitting no beat. The cron fires on schedule but the watchdog sees no beats and fires cron_freshness after the 45-min livenessWindow (last beat 2026-06-22T14:00:07, alert at 15:00:08). Sibling 15-min cron portal-action-healer.ts has no early return and stays green.

**Likely target:** `src/lib/inngest/ticket-csat.ts`

## Phase 1 — close it 🚧
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Fix landed:** `ticket-csat.ts` — the `if (!due.length)` early return now emits `step.run("emit-heartbeat")` → `emitCronHeartbeat("ticket-csat-cron", { ok: true, produced: { sent: 0, … } })` before returning, so every tick (idle included) writes exactly one `loop_heartbeats` beat. Mirrors the established idle-tick fix in `marketing-text.ts`. Brain page `inngest/ticket-csat.md` updated. `npx tsc --noEmit` clean.

## Verification
- Re-trigger the originating condition (signature `loop:ticket-csat-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:ticket-csat-cron` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
