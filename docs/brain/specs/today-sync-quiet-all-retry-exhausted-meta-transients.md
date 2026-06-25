# Today Sync — quiet ALL retry-exhausted Meta transients, not just subcode 1504018

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] + [[../inngest/today-sync]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/inngest/today-sync.ts (broaden ishandledtimeoutblip into ishandledtransient — quiet when metacode is 1 or 2, or the original 1504018 subcode, mirroring graph-retry.ts:istransientgrapherror; update the brain page docs/brain/inngest/today-sync.md § per-account meta error handling to match)::monitor-false-positive`
**Repair-signature:** `vercel:3ade2095203d2c5a`

Stop the Control Tower error feed from escalating Meta's transient 'Service temporarily unavailable' (code 2, subcode 1504044) errors that today-sync's own retry wrapper already classified as transient and the next 5-min cron tick self-heals — without going silent on real failures (auth 190, permission 200/10/803, disabled account).

## Problem (from Control Tower signature `vercel:3ade2095203d2c5a`)
On 2026-06-25 a today-sync run logged 'ERR [Today Sync] Meta error for 196487894712827: meta_400: Service temporarily unavailable' with `code:2, error_subcode:1504044`. graph-retry.ts:46 explicitly classifies code===1/2 + is_transient + 429/5xx as transient and retries 4× with backoff; this run exhausted the budget during a Meta-side outage and threw. today-sync.ts:96 quiet-handler only checks `subcode === 1504018` ('Your request timed out'), so every other class of confirmed-transient Meta error — including the one the retry wrapper EXPLICITLY flagged transient — falls through to console.error and Control Tower escalates a healthy, self-healing loop.

**Likely target:** `src/lib/inngest/today-sync.ts (broaden isHandledTimeoutBlip into isHandledTransient — quiet when metaCode is 1 or 2, or the original 1504018 subcode, mirroring graph-retry.ts:isTransientGraphError; update the brain page docs/brain/inngest/today-sync.md § 'Per-account Meta error handling' to match)`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:3ade2095203d2c5a`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:3ade2095203d2c5a` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
