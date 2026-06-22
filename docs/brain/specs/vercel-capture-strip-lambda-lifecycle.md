# Vercel error-feed: don't mint duplicate signatures from raw Lambda START/END/REPORT lifecycle blocks 🚧

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/app/api/webhooks/vercel-logs/route.ts::monitor-false-positive`
**Repair-signature:** `vercel:ebdf493a37c60c34`

Stop the Vercel log-drain capture from recording a function's bare Lambda lifecycle/REPORT block as its own error incident. A single failed request currently lands twice in the feed — once as the app's actionable console.error (which already gets a stable signature + repair spec) and once as a non-actionable platform 502 wrapper (START/END/REPORT RequestId + Duration/Memory). Scope the capture so the lifecycle scaffolding is stripped before signature-grouping, collapsing all proxy-5xx-on-a-route entries to one stable signature (or suppressing them when the function error is already captured), eliminating the redundant noise without touching any product code.

## Problem (from Control Tower signature `vercel:ebdf493a37c60c34`)
src/app/api/webhooks/vercel-logs/route.ts isError() (line 71-75) captures any log with statusCode>=500, and groupKey() (line 78-82) uses log.message verbatim as a keyPart. For a 502 on /api/portal?route=removeLineItem the drain delivers both the app's console.error('[appstleRemoveLineItem] error:'…, subscription-items.ts:223 → signature vercel:0dda1c7b9495ebb1, already specced) AND a separate Lambda lifecycle entry whose entire message is the START RequestId / [POST] …status=502 / END / REPORT … Duration/Memory block. The lifecycle entry carries no error body, normalizes to a distinct stable signature (this signature, vercel:ebdf493a37c60c34, count=2), and triggers a redundant Repair-Agent job for an error whose root cause is already tracked. Detect bare-lifecycle messages (START/END/REPORT RequestId scaffolding) and either reduce the message to just the '[METHOD] path status=NNN' line for grouping, or skip the entry, so one failure no longer mints two signatures.

**Likely target:** `src/app/api/webhooks/vercel-logs/route.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** `vercel-logs/route.ts` adds `isBareLifecycle()` and the `isError()` re-filter now drops any 5xx whose entire message is `START`/`END`/`REPORT RequestId` scaffolding + the bare `[METHOD] path status=NNN` proxy line — so a bare lifecycle wrapper produces **no** `error_events` row / signature. A failure's actionable `console.error` (own signature + repair spec) is unaffected; a lifecycle block carrying a real message/stack ("Task timed out", uncaught exception) is not bare and is still captured. Brain: [[../integrations/vercel-log-drain]].

## Verification
- Re-trigger the originating condition (signature `vercel:ebdf493a37c60c34`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:ebdf493a37c60c34` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
