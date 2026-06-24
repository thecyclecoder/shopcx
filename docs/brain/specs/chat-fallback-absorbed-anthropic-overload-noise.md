# Don't open a Control Tower incident when the chat Haiku fallback absorbs a Sonnet overload ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/remedy-selector.ts::monitor-false-positive`
**Repair-signature:** `vercel:43e4b03698fb1c38`

Scope the error-feed capture so a transient Anthropic 529/overload that is fully absorbed by generateOpenEndedResponse's designed Haiku fallback no longer surfaces as an open Control Tower error. The cancel-journey live chat has a robust Sonnet→breaker→Haiku→graceful-degrade chain; only a terminal failure (both legs down, customer gets the degrade reply) is actionable. Re-level the intermediate diagnostic so the monitor pages on real failures, not on healthy self-healing.

## Problem (from Control Tower signature `vercel:43e4b03698fb1c38`)
src/lib/remedy-selector.ts:415 emits a top-level console.error on EVERY Sonnet failure (e.g. the captured 529 overloaded_error, request_id req_011CcLNB5CWqYsfMuJjRyLKy) before the Haiku fallback at line 421 even runs. The Vercel log drain (src/app/api/webhooks/vercel-logs/route.ts, isError() captures level==='error') scrapes that line and recordError opens a 'vercel' incident (event 6b9c11e1, count=1) even though the Haiku retry typically returns a valid reply and the breaker already records the failure. Result: every transient Anthropic overload absorbed by the fallback mints a false Control Tower incident.

**Likely target:** `src/lib/remedy-selector.ts`

## Phase 1 — close it ⏳
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:43e4b03698fb1c38`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:43e4b03698fb1c38` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
