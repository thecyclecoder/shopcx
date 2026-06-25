# today-sync: downgrade handled Meta timeout blips to console.warn so the error feed doesn't escalate self-healing per-account skips

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/inngest/today-sync.ts::monitor-false-positive`
**Repair-signature:** `vercel:da5909a718f652c0`

Stop the Control Tower error feed from escalating handled, self-healing Meta API timeouts that the today-sync cron already absorbs and retries on its 5-minute cadence. Real Meta failures (auth, scope, disabled account) must still escalate; only the known-transient subcode-1504018-style timeouts get downgraded.

## Problem (from Control Tower signature `vercel:da5909a718f652c0`)
today-sync.ts:90 logs every per-account Meta exception at console.error, including subcode 1504018 ('Your request timed out') which is a Meta-side backend blip — the catch on lines 89-91 already skips that account and the next 5-min cron run retries successfully (vercel:da5909a718f652c0 fired once with count=1, confirming self-heal). Because the catch uses console.error, Vercel routes it into the error feed and Control Tower escalates it as an open bug, even though the data path is intact. The cron is doing the right thing; the log level is just lying about severity.

**Likely target:** `src/lib/inngest/today-sync.ts`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:da5909a718f652c0`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:da5909a718f652c0` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
