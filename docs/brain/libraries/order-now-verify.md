# libraries/order-now-verify

Async-aware verification of an order-now / bill_now trigger — pause after firing, then re-read the REAL charge outcome (paid order vs `subscription.billing-failure` / dunning) and only then stamp the [[../tables/ticket_resolution_events]] row.

**File:** `src/lib/commerce/order-now-verify.ts` · **Inngest fn:** `src/lib/inngest/order-now-verify.ts`

Phases 1 + 2 of [[../specs/order-now-verify-async-result-then-decline-recovery-migrate-and-deterministic-retry]]. Derived from ticket 0a9e4d7f (Judy) — Appstle bill_now succeeded on the trigger ack, Shopify rejected the charge minutes later, the sub dropped into dunning, and the customer had already been told her order was on the way.

## Why

Order-now / bill_now is IMMEDIATE for internal (Braintree) subs but DELAYED for Appstle — the vendor accepts the trigger, then charges asynchronously and can DECLINE. `subscriptionOrderNow` reports success on the trigger ack alone (returns `{ success: true, summary: "Triggered bill_now" }`), so a later decline was invisible to the ticket ledger.

This library gates the ticket_resolution_events verdict on a REAL paid order:

1. Fire order-now via [[./commerce__subscription#subscriptionOrderNow]].
2. Schedule `commerce/order-now.verify` on Inngest with a flavor-specific delay (30s internal, 5m Appstle).
3. The Inngest function reads customer_events + subscriptions + orders since `fired_at`, computes the verdict, and stamps `ticket_resolution_events.verified_at + verified_outcome`.
4. Unknown-at-first re-schedules once more (5m) then terminally resolves to `drifted` — no perpetually-pending ledger rows.

## Exports

- `computeOrderNowVerdict(evidence): 'paid' | 'declined' | 'unknown'` — pure predicate mapping evidence to verdict. Pinned by [[./order-now-verify.test]] so a refactor can't silently flip an Appstle billing-failure to `confirmed` (the Judy failure mode).
- `verifyOrderNowOutcome(admin, opts)` — reads the evidence from customer_events / subscriptions / orders and calls the predicate. Returns `{ verdict, evidence }`.
- `scheduleOrderNowVerify(input)` — fires the Inngest event with the flavor-specific delay + attempt counter. Extracted so callers that fire order-now their own way (portal handlers) can still schedule the verify.
- `subscriptionOrderNowVerified(workspaceId, contractId, ctx)` — the direct-action wrapper. Fires bill_now AND schedules the verify. Returns `{ success, internal, pending, fired_at, subscription_id }`.
- `dispatchRecoveryOnDecline(input, deps?)` — **Phase 2** — fires the update-payment-method recovery journey exactly once for a declined verdict. Confirming-predicate guard: soft-skips when a `dunning.recovery_email_sent` `customer_events` row exists for this customer since `fired_at` (dunning's billing-failure path may already have delivered). Wraps [[./payment-recovery-email]]. Overridable `deps` (`alreadySentSinceFiredAt`, `sendRecovery`) make the guard + delivery testable without Resend / Supabase.
- `defaultRecoveryDispatchDeps()` — the production deps wiring (real `customer_events` count + `sendPaymentRecoveryEmail`). Extracted so tests swap either side cleanly.

## Verdict decision table

| Evidence | Verdict |
|---|---|
| `hasNewPaidOrder` OR `hasBillingSuccessEvent` OR `lastPaymentStatus='succeeded'` | `paid` |
| `hasBillingFailureEvent` OR `lastPaymentStatus='failed'` (without paid signal) | `declined` |
| Neither | `unknown` (reschedule) |

Paid signal wins over declined signal — a card rotation between fire and verify ends up with an ok account state; the ledger row reflects reality.

## Wiring

- **Caller:** `directActionHandlers.bill_now` in [[./action-executor]] uses `subscriptionOrderNowVerified`. On Appstle (`pending: true`) it sets `ctx._resolutionOutcomePending = true` so the executor's return-time `verified_outcome='confirmed'` stamp is SKIPPED — the async verify owns the verdict.
- **Ledger stamp:** the Inngest function stamps `ticket_resolution_events.verified_at + verified_outcome` via a compare-and-set on `verified_at IS NULL` (idempotent — a re-drive can't overwrite an earlier verdict).
- **Inngest event:** `commerce/order-now.verify` with `{ workspace_id, subscription_id, contract_id, fired_at, is_internal, resolution_event_id?, ticket_id?, customer_id?, attempt }`. Registered in [[../inngest/registered-functions]].

## Phase sequencing

- **Phase 1 (landed):** async verify only — declined → stamp `drifted`.
- **Phase 2 (landed):** decline branch triggers the update-payment-method recovery journey via `dispatchRecoveryOnDecline` → [[./payment-recovery-email]]. Guarded so exactly one delivery lands per (customer, fired_at) window even when dunning's billing-failure webhook is racing us.
- **Phase 3:** journey completion migrates Appstle→internal ([[./vault-and-migrate-payment-method]]) and deterministically retries order-now on the internal sub.
- **Phase 4:** verified paid order triggers a lightweight Sol pass and only then sends the customer confirmation (message-is-last).

## See also

- [[./commerce__subscription]] — the underlying `subscriptionOrderNow` fire.
- [[./appstle]] — `orderNowByContract` + why Appstle is delayed.
- [[./payment-recovery-email]] — magic-link recovery email + tagged closed ticket the Phase 2 decline branch dispatches.
- [[../tables/ticket_resolution_events]] — the write-ahead ledger this library stamps.
- [[../lifecycles/subscription-billing]] · [[../lifecycles/dunning]] — the flows this library integrates with.
- [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] — the sibling message-is-last spec (Phase 4 integration point).
