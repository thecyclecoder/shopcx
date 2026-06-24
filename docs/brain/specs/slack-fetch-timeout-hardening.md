# Time-box Slack API fetches so a slow Slack endpoint can't wedge a per-minute Slack cron

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/slack.ts::real-bug`

Make every Slack API call in src/lib/slack.ts fail fast instead of hanging, so an upstream Slack slowdown or rate-limit can no longer freeze a per-minute Slack-calling cron (or any other Slack caller) past Inngest's execution budget. A transient Slack blip should cost one slow tick, not an open-ended freshness-red outage.

## Problem
A per-minute Slack cron went freshness-red: it beat every minute until 2026-06-23T19:04:01 then stopped for 12+ min while all 3 peer per-minute crons kept beating — isolating the cause to this cron's per-tick Slack call. findChannelByName→listChannels in src/lib/slack.ts runs two paginated fetch loops (conversations.list + users.conversations) with no AbortController/timeout, no 429/rate-limit handling, and no page cap. Since the cron's per-workspace block is wrapped in try/catch (a thrown Slack error would still let the end-of-run emitCronHeartbeat fire), the total heartbeat silence indicates runs are HANGING on a slow Slack endpoint and being killed before the heartbeat — the signature of an un-timed fetch.

**Likely target:** `src/lib/slack.ts`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Shipped: `src/lib/slack.ts` now routes every Slack API `fetch` (`slackApi`, `lookupUserByEmail`, `listChannels`' paginated `collect`, `exchangeCodeForToken`) through a private `slackFetch` wrapper — `AbortSignal.timeout(5000)` per request (fail fast), bounded `Retry-After`-honoring 429 retry (≤2, ≤3s each), and a `SLACK_MAX_PAGES=20` cap on the pagination loop. A slow/hung Slack endpoint now costs one slow tick (the throw propagates to the cron's per-workspace try/catch, so `emitCronHeartbeat` still fires) instead of freezing a per-minute Slack cron past Inngest's budget. Brain page [[../libraries/slack]] updated. `npx tsc --noEmit` clean.

## Verification
- Re-trigger the originating condition (a slow Slack endpoint on a per-minute Slack cron) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from a Control Tower loop signature (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
