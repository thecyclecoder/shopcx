# Drop bare Lambda 502 proxy-summary wrappers in the Vercel error feed 🚧

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] (sibling of [[../specs/error-feed-drop-aborted-stream-noise]]) · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/app/api/webhooks/vercel-logs/route.ts (isbarelifecycle — relax the proxy-summary matcher to drop the $ anchor / tolerate trailing tokens after status=nnn; add a regression test fixture using the leaked vercel:ebdf493a37c60c34 blob)::monitor-false-positive`
**Repair-signature:** `vercel:ebdf493a37c60c34`

Close the gap in the Control Tower vercel-logs capture so non-actionable bare Lambda lifecycle/proxy wrappers around an already-handled application 502 (e.g. /api/portal Appstle-error responses) are dropped before signature-grouping, instead of minting a redundant open incident that pages owners on a healthy, ticketed loop.

## Problem (from Control Tower signature `vercel:ebdf493a37c60c34`)
Signature vercel:ebdf493a37c60c34 is open (count=2) for '502 /api/portal: START…[POST] /api/portal?route=removeLineItem status=502…END…REPORT'. This is the bare Lambda lifecycle wrapper, not a crash (669ms, 343MB/2048MB; the route's only 502 source is the deliberate handleAppstleError response, and the outer catch returns 401 not 502). isBareLifecycle() in src/app/api/webhooks/vercel-logs/route.ts already exists to drop this exact signature (named in its comment) but its proxy-summary regex /^\[[A-Z]+\]\s+\S+\s+status=\d{3}$/ is too strictly $-anchored to match the real proxy line, so .every() fails and the wrapper is captured. The underlying Appstle failure is already surfaced separately and opens a portal-action-failed ticket, so this incident is pure duplicate noise.

**Likely target:** `src/app/api/webhooks/vercel-logs/route.ts (isBareLifecycle — relax the proxy-summary matcher to drop the $ anchor / tolerate trailing tokens after status=NNN; add a regression test fixture using the leaked vercel:ebdf493a37c60c34 blob)`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Shipped: `isBareLifecycle` moved out of the route into [[../libraries/control-tower]] `error-feed.ts` (exported, reusable + unit-testable — same factoring as sibling `isAbortedStreamNoise`), with the proxy-summary matcher relaxed from `/^\[[A-Z]+\]\s+\S+\s+status=\d{3}$/i` to `/^\[[A-Z]+\]\s+\S+\s+status=\d{3}\b/i` — the `$` anchor dropped so the line is matched even with trailing tokens (`… status=502 669ms`) after the status. `src/app/api/webhooks/vercel-logs/route.ts` now imports it. Regression fixture using the leaked `vercel:ebdf493a37c60c34` blob added in `error-feed.test.ts` (`npm run test:error-feed`, 6 tests pass). Brain pages updated: [[../integrations/vercel-log-drain]] + [[../libraries/control-tower]]. `npx tsc --noEmit` clean.

## Verification
- Re-trigger the originating condition (signature `vercel:ebdf493a37c60c34`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:ebdf493a37c60c34` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
