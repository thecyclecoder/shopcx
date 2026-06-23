# Time-box Slack API fetches so a slow Slack endpoint can't wedge the slack-roadmap-notify cron ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/lib/slack.ts::real-bug`
**Repair-signature:** `loop:slack-roadmap-notify`

Make every Slack API call in src/lib/slack.ts fail fast instead of hanging, so an upstream Slack slowdown or rate-limit can no longer freeze the per-minute slack-roadmap-notify cron (or any other Slack caller) past Inngest's execution budget. A transient Slack blip should cost one slow tick, not an open-ended freshness-red outage.

## Problem (from Control Tower signature `loop:slack-roadmap-notify`)
slack-roadmap-notify went freshness-red: it beat every minute until 2026-06-23T19:04:01 then stopped for 12+ min while all 3 peer per-minute crons kept beating — isolating the cause to this cron's per-tick Slack call. findChannelByName→listChannels in src/lib/slack.ts runs two paginated fetch loops (conversations.list + users.conversations) with no AbortController/timeout, no 429/rate-limit handling, and no page cap. Since the cron's per-workspace block is wrapped in try/catch (a thrown Slack error would still let the end-of-run emitCronHeartbeat fire), the total heartbeat silence indicates runs are HANGING on a slow Slack endpoint and being killed before the heartbeat — the signature of an un-timed fetch.

**Likely target:** `src/lib/slack.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `loop:slack-roadmap-notify`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:slack-roadmap-notify` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
