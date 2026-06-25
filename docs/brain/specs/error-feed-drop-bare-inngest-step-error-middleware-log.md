# Error feed: drop the bare Inngest middleware step-error log from the Vercel feed

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] (sibling of [[../specs/error-feed-drop-inngest-step-retry-throws]]) · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/error-feed.ts (add isbareinngeststeperrormiddlewarelog helper + matching test in error-feed.test.ts) and src/app/api/webhooks/vercel-logs/route.ts (call it in iserror alongside isbarelifecycle / isabortedstreamnoise)::monitor-false-positive`
**Repair-signature:** `vercel:b1daa612f563f5e9`

Stop the Control Tower's Vercel-log ingester from minting fresh OPEN incidents for Inngest's built-in LoggerMiddleware bare 'Inngest step error' log line — the SDK fires it on every step throw (transient + final), Vercel's drain serializes only the bare Pino msg field, and terminal failures are already authoritatively captured on the inngest source via inngest/function.failed. The bare middleware log on /api/inngest is duplicate noise on a healthy retry loop; drop it before signature grouping, the same monitor-only treatment given to isBareLifecycle / isAbortedStreamNoise.

## Problem (from Control Tower signature `vercel:b1daa612f563f5e9`)
Signature vercel:b1daa612f563f5e9 was opened by the vercel log drain for 'ERR /api/inngest: Inngest step error' (count=7, last_seen 2026-06-25T15:00:24Z, status=0). The message is the literal label 'Inngest step error' with no error detail — emitted by Inngest's built-in LoggerMiddleware.onStepError at node_modules/inngest/components/Inngest.js:593: `this.proxyLogger.error({ err: arg.error }, 'Inngest step error')`. onStepError fires on EVERY step throw, including transient throws Inngest will retry; the actual error object lives in the JSON `err` context which Vercel's drain doesn't surface as the message — only the bare Pino msg label survives. Terminal failures are already captured on source='inngest' by inngest-failure-capture.ts (triggers on inngest/function.failed). The sibling in-flight spec error-feed-drop-inngest-step-retry-throws.md (signature vercel:0ffd0e07c0fe9336) added isTransientInngestStepRetryThrow which only matches messages carrying '(attempt N/M)' text — the bare-label variant passes through and pages Platform owners on the same healthy retry loop. The vercel-logs ingester (src/app/api/webhooks/vercel-logs/route.ts isError, line 70) needs a third drop rule alongside isBareLifecycle / isAbortedStreamNoise that matches path '/api/inngest' + the exact bare 'Inngest step error' middleware msg.

**Likely target:** `src/lib/control-tower/error-feed.ts (add isBareInngestStepErrorMiddlewareLog helper + matching test in error-feed.test.ts) and src/app/api/webhooks/vercel-logs/route.ts (call it in isError alongside isBareLifecycle / isAbortedStreamNoise)`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:b1daa612f563f5e9`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:b1daa612f563f5e9` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
