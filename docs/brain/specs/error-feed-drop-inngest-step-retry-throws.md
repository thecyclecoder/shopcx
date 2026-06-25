# Error feed: drop mid-retry Inngest step throws from the Vercel log drain

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/error-feed.ts (add istransientinngeststepretrythrow + matching test) and src/app/api/webhooks/vercel-logs/route.ts (call it in iserror alongside isbarelifecycle / isabortedstreamnoise; also pass transient: true through recorderror so the existing recur-window still escalates a chronic-failure signature)::monitor-false-positive`
**Repair-signature:** `vercel:0ffd0e07c0fe9336`

Stop the Control Tower's Vercel-log ingester from minting fresh OPEN incidents when an Inngest step intentionally throws to trigger its own retry — the same monitor-only treatment the inngest source already gives http_unreachable transport noise via isTransientInngestTransportError. A non-final (attempt N/M with N<M) throw on /api/inngest is the retry mechanism working, not a defect; recording it as a vercel error pages Platform owners on a loop that already self-heals.

## Problem (from Control Tower signature `vercel:0ffd0e07c0fe9336`)
Signature vercel:0ffd0e07c0fe9336 was opened by the vercel log drain for 'ERR /api/inngest: Error: transient publish failure (attempt 1/5): Please reduce the amount of data you're asking for, then retry your request' at 2026-06-25T15:00:24Z. The thrown error originates at src/lib/inngest/social-scheduler.ts:310 — socialPublish detects a transient Meta Graph failure (codes 1/2/4/17/32/341/613/5xx/429 per src/lib/social/publish.ts:41 isTransientGraph) and throws so Inngest re-runs the step with backoff (PUBLISH_RETRIES=4). Attempt 1/5 means 4 attempts remain; the function body never finally-failed, no scheduled_social_posts row is stuck (mark-publishing + finalize bracket the retry). The vercel ingester (src/app/api/webhooks/vercel-logs/route.ts isError, line 70) only drops isBareLifecycle + isAbortedStreamNoise; it has no analog for Inngest's intentional mid-retry throws, so every transient Meta blip mints a fresh incident on a healthy loop.

**Likely target:** `src/lib/control-tower/error-feed.ts (add isTransientInngestStepRetryThrow + matching test) and src/app/api/webhooks/vercel-logs/route.ts (call it in isError alongside isBareLifecycle / isAbortedStreamNoise; also pass `transient: true` through recordError so the existing recur-window still escalates a chronic-failure signature)`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:0ffd0e07c0fe9336`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:0ffd0e07c0fe9336` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
