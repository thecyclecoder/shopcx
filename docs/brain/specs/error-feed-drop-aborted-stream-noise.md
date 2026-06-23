# Error feed: drop client-abort framework-internal stream errors from Vercel capture ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/app/api/webhooks/vercel-logs/route.ts (iserror — add an isabortedstreamnoise() companion to isbarelifecycle: drop level:error entries with status 0 whose message matches the node web-streams abort family — transformalgorithm is not a function, invalid state: controller is already closed, err_stream_premature_close/aborted — and an at ignore-listed frames-only stack); factor the matcher into src/lib/control-tower/error-feed.ts so other feeds can reuse it::monitor-false-positive`
**Repair-signature:** `vercel:801aa4e3922198d3`

The Control Tower Vercel error feed is paging owners about Node.js-internal Web-Streams teardown errors that fire when a visitor aborts an SSR stream mid-flight (client disconnect). These are non-actionable framework noise with no fix in our code, the same genre as the bare-Lambda-lifecycle wrappers we already drop. Add a companion capture filter so this aborted-stream family is never minted as an open incident.

## Problem (from Control Tower signature `vercel:801aa4e3922198d3`)
Error event b9856952 (signature vercel:801aa4e3922198d3, digest 696838421) on /store/[workspace]/[slug] is `TypeError: controller[kState].transformAlgorithm is not a function at ignore-listed frames`. The sample carries status:0 (response never completed → client aborted) and a stack with zero frames in our code — it is the documented Node core TransformStream race (nodejs/node PR #62040) surfaced by Next.js SSR streaming on client disconnect. isError() in vercel-logs/route.ts admits it because the log line is level:'error', so a healthy PDP mints an open incident and pages owners. No product-code fix exists; the PDP route/components have no src="#" or empty-src trigger.

**Likely target:** `src/app/api/webhooks/vercel-logs/route.ts (isError — add an isAbortedStreamNoise() companion to isBareLifecycle: drop level:'error' entries with status 0 whose message matches the Node Web-Streams abort family — 'transformAlgorithm is not a function', 'Invalid state: Controller is already closed', ERR_STREAM_PREMATURE_CLOSE/'aborted' — and an 'at ignore-listed frames'-only stack); factor the matcher into src/lib/control-tower/error-feed.ts so other feeds can reuse it`

## Phase 1 — close it ✅�
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Built:** `isAbortedStreamNoise(message, status)` added + exported from `src/lib/control-tower/error-feed.ts` (reusable across feeds), wired as a companion to `isBareLifecycle` in `src/app/api/webhooks/vercel-logs/route.ts` `isError()`. Drops `status:0` `level:'error'` entries whose message matches the Web-Streams abort family (`transformAlgorithm is not a function` · `Invalid state: Controller is already closed` · `ERR_STREAM_PREMATURE_CLOSE`/`aborted`) AND whose stack is `at ignore-listed frames`-only (zero frames in our code). Brain page [[../integrations/vercel-log-drain]] updated. `tsc --noEmit` clean. Verification (re-trigger `vercel:801aa4e3922198d3` → no new incident) pending prod.

## Verification
- Re-trigger the originating condition (signature `vercel:801aa4e3922198d3`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:801aa4e3922198d3` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
