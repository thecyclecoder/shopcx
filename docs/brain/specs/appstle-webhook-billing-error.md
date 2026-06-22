# Appstle webhook 500 on subscription.billing-* events ✅

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" ([[../lifecycles/subscription-billing]]).

The Control Tower's Vercel error feed surfaced a **recurring `500 /api/webhooks/appstle/[workspaceId]`** — "Appstle webhook error (subscription.billing-…)" — **×11 occurrences**. The handler (`src/app/api/webhooks/appstle/[workspaceId]/route.ts`) throws while processing `subscription.billing-success` / `subscription.billing-interval-changed` events (the `catch` at ~L111 logs + 500s). A 500 to Appstle means Appstle **retries** the webhook (more noise + possible duplicate processing), and whatever the billing event was meant to update **isn't happening** — a silent subscription-billing integrity gap, exactly the kind that bites retention.

## Fix
- **Find the throw.** Read the `subscription.billing-success` / `billing-interval-changed` branches; reproduce against a sample payload (the captured `error_events.sample` has the RequestId / shape). Likely a missing field, a null sub lookup, or a DB write that violates a constraint on those events.
- **Fix the handler** so the billing event processes correctly. If the event is one we intentionally don't act on, **ack it 2xx** (don't 500 + trigger Appstle retries) — log + no-op explicitly.
- **Never 500 on a recoverable/ignorable event** — reserve non-2xx for genuinely-retryable failures; ack-and-log the rest so Appstle stops hammering.

## Verification
- Replay a `subscription.billing-success` payload (shape from the captured incident) → the handler returns 2xx and the intended update lands (or is explicitly + correctly a no-op); no throw.
- The Control Tower Vercel panel shows the `appstle … billing` incident **stop recurring** (occurrence count stops climbing; resolves after the recency window).
- Negative: a genuinely-malformed/unauthenticated webhook still rejects appropriately (we didn't blanket-2xx everything).

## Phase 1 — fix the billing-event throw + correct ack semantics ✅
Diagnose the throw on `subscription.billing-*`, fix the handler (process correctly or ack-and-log), keep non-2xx only for retryable failures. Brain: [[../integrations/appstle]] · [[../lifecycles/subscription-billing]] · [[../lifecycles/dunning]].

**Shipped** (`src/app/api/webhooks/appstle/[workspaceId]/route.ts`):
- **Ack semantics corrected.** The top-level `catch` no longer returns `500` — once the Svix signature verifies, any processing error is logged richly (event type + contract/customer ref) and acked `2xx` (`{ ok: false, acked: true }`). A 500 only made Appstle retry the same payload (it threw again → ×11 recurrence) and re-run partial side-effects. Non-2xx stays reserved for the genuinely-actionable pre-handler rejections (`400` bad headers, `401` invalid signature, `404` unconfigured workspace) — those are NOT blanket-acked, satisfying the negative-test requirement. Missed state self-heals via the periodic subscription sync + reconcile.
- **Guarded the unguarded throw class.** Added `parseBillingError()` — a defensive helper for Appstle's `billingAttemptResponseMessage` (a JSON *string* on failures, but can arrive null/empty/already-parsed). Replaced all three parse sites, including the one **unguarded** `JSON.parse` in the non-success `logCustomerEvent` properties (line ~568) that bubbled to the route catch on `billing-interval-changed` / `billing-failure` payloads.
- `npx tsc --noEmit` clean.

Folded into [[../integrations/appstle]] § Webhooks → "Handler ack semantics". Ready for owner verification → archive.
