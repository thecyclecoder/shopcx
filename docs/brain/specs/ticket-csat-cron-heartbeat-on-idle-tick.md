# Ticket CSAT cron must beat on idle ticks (no-due-tickets early-return skips the heartbeat) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] (follows [[../specs/control-tower-complete-coverage]]; same fix class as [[../specs/cron-heartbeat-on-idle-tick]] + [[../specs/meta-capi-dispatch-heartbeat-on-idle-tick]]) · **Repair-signature:** `loop:ticket-csat-cron` · **Verdict:** real-bug

Make ticket-csat-cron emit its Control Tower heartbeat on every tick, including idle ticks where no tickets are in the 48h–7d send window, so a healthy-but-idle loop reads green (produced:{sent:0}) instead of red never_fired. The heartbeat asserts 'Inngest invoked me' independent of whether there was work; move emitCronHeartbeat so it is reached on all return paths (beat before the line-90 early-return, or make it the last unconditional step covering the idle case), restoring the liveness contract the early-return currently violates.

## Problem (from Control Tower signature `loop:ticket-csat-cron`)
src/lib/inngest/ticket-csat.ts:90 early-returns `if (!due.length) return { sent: 0, skipped_too_old: skippedCount, skipped_no_reply: 0 };` before the emit-heartbeat step at lines 159-161, so on every idle tick (no in-window CSAT-eligible tickets — the normal post-deploy state) the cron runs but never beats. With 0 all-time loop_heartbeats and the deploy now past the registry's 45m cadence+grace window (registry.ts:286, expected */15), monitor.ts:236-248 trips never_fired even though the cron is correctly registered (registered-functions.ts:126), served, and invoked every 15 min. Identical to the already-fixed cron-heartbeat-on-idle-tick and meta-capi-dispatch-heartbeat-on-idle-tick siblings.

**Likely target:** `src/lib/inngest/ticket-csat.ts`

## Phase 1 — close it ✅
Removed the `if (!due.length) return …` early-return at `src/lib/inngest/ticket-csat.ts:90`. The per-ticket `for…of due` loop is a no-op when `due` is empty, so control now always falls through to the unconditional `emit-heartbeat` step (lines ~159-161), which beats on every tick including idle ones. Result on an idle tick is `{ sent: 0, skipped_too_old, skipped_no_reply: 0, batch_size: 0 }`. Brain page [[../inngest/ticket-csat]] documents the unconditional heartbeat. `npx tsc --noEmit` clean.

## Verification
- In Supabase, confirm `loop_heartbeats` gains a row with `loop_id = 'ticket-csat-cron'` within ~15 min of deploy even when no tickets are in the 48h–7d window → expect a fresh `last_beat_at` (was 0 all-time beats before).
- On the Control Tower dashboard, the `ticket-csat-cron` tile → expect green `produced:{sent:0,…}` on an idle tick, not red `never_fired`.
- Re-trigger the originating condition (signature `loop:ticket-csat-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.
- Read `src/lib/inngest/ticket-csat.ts` → expect no `if (!due.length) return` before the `emit-heartbeat` step; the beat is the last unconditional `step.run`.

> Authored by the box Repair Agent from Control Tower signature `loop:ticket-csat-cron` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
