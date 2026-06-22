# Portal OTP send-failure returns structured non-5xx, not a 502 ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Repair-signature:** `vercel:202c7bc719d2363f` · **Verdict:** real-bug

Stop the portal OTP routes from emitting HTTP 502 for an expected, client-handled Twilio delivery failure, so a single customer's failed OTP send no longer surfaces as a server error in the Vercel error feed and pages the owner. The customer flow is unchanged (the login client already falls back to magic-link); this only corrects the status code so observability reflects reality.

## Problem (from Control Tower signature `vercel:202c7bc719d2363f`)
src/app/api/portal/otp/start/route.ts:102-104 and src/app/api/portal/otp/resend/route.ts:61-62 return {status:502} when startVerificationWithFallback fails. Twilio Verify failing to deliver one OTP (bad number + no/failed email, after the SMS→email fallback in src/lib/twilio-verify.ts) is an expected per-request outcome, and LoginClient.tsx:141-164 already handles a non-eligible body by routing to /api/portal/magic-login. The 502 is captured by the >=500 filter in src/app/api/webhooks/vercel-logs/route.ts and pages the owner on the Control Tower Vercel-errors panel (signature vercel:202c7bc719d2363f) — a false server-error alert for a handled condition.

**Likely target:** `src/app/api/portal/otp/start/route.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Shipped 2026-06-22: `src/app/api/portal/otp/start/route.ts` returns `200 {eligible:false, suggest_magic_link:true, error:"verify_send_failed", details}` (the login client already routes a non-eligible body to magic-login, so the customer flow is unchanged) and `src/app/api/portal/otp/resend/route.ts` returns `422 {error:"verify_send_failed"}` instead of `502` when `startVerificationWithFallback` fails. Documented in [[../libraries/twilio-verify]] Gotchas and [[../lifecycles/customer-portal]].

## Verification
- Re-trigger the originating condition (signature `vercel:202c7bc719d2363f`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:202c7bc719d2363f` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
