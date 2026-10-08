# libraries/order-now-verify

Async-aware verification of an order-now / bill_now trigger — pause after firing, then re-read the REAL charge outcome (paid order vs `subscription.billing-failure` / dunning) and only then stamp the [[../tables/ticket_resolution_events]] row.

**File:** `src/lib/commerce/order-now-verify.ts` · **Inngest fn:** `src/lib/inngest/order-now-verify.ts`

Phases 1 + 2 + 3 + 4 + 5 of [[../specs/order-now-verify-async-result-then-decline-recovery-migrate-and-deterministic-retry]]. Derived from ticket 0a9e4d7f (Judy) — Appstle bill_now succeeded on the trigger ack, Shopify rejected the charge minutes later, the sub dropped into dunning, and the customer had already been told her order was on the way. Phase 5 documents the end-to-end verify→recover→migrate→retry→confirm flow across [[../lifecycles/subscription-billing]] § Order-now (bill_now) and [[../lifecycles/dunning]] § Recovery email is also the order-now decline hand-off.

## Why

Order-now / bill_now is IMMEDIATE for internal (Braintree) subs but DELAYED for Appstle — the vendor accepts the trigger, then charges asynchronously and can DECLINE. `subscriptionOrderNow` reports success on the trigger ack alone (returns `{ success: true, summary: "Triggered bill_now" }`), so a later decline was invisible to the ticket ledger.

This library gates the ticket_resolution_events verdict on a REAL paid order:

1. Fire order-now via [[./commerce__subscription#subscriptionOrderNow]].
2. Schedule `commerce/order-now.verify` on Inngest with a flavor-specific delay (30s internal, 5m Appstle).
3. The Inngest function reads customer_events + subscriptions + orders since `fired_at`, computes the verdict, and stamps `ticket_resolution_events.verified_at + verified_outcome`.
4. Unknown-at-first re-schedules once more (5m) then terminally resolves to `drifted` — no perpetually-pending ledger rows.

## Exports

- `computeOrderNowVerdict(evidence): 'paid' | 'declined' | 'nothing_due' | 'unknown'` — pure predicate mapping evidence to verdict. Pinned by [[./order-now-verify.test]] so a refactor can't silently flip an Appstle billing-failure to `confirmed` (the Judy failure mode) nor a skipped spent-cycle to a false `paid` (the Ashley Denson failure mode).
- `verifyOrderNowOutcome(admin, opts)` — reads the evidence from customer_events / subscriptions / orders and calls the predicate. Returns `{ verdict, evidence, nextBillingDate }` — `nextBillingDate` is carried so a `nothing_due` verdict can tell the customer the REAL next order date.
- `logOrderNowNothingDue(input)` — **nothing_due** — writes the `subscription.order_now_nothing_due` customer_event (`ORDER_NOW_NOTHING_DUE_EVENT`) that `verifyOrderNowOutcome` reads as the `hasNothingDueSkip` signal. Called by the shopcx + internal renewal-attempt pipelines when a customer-pressed order-now (`order_now: true` on the renewal-attempt event) resolves against an already-billed / not-yet-due cycle and so does NOT charge. Best-effort — a logging failure never breaks the pipeline's skip path.
- `scheduleOrderNowVerify(input)` — fires the Inngest event with the flavor-specific delay + attempt counter. Extracted so callers that fire order-now their own way (portal handlers) can still schedule the verify.
- `subscriptionOrderNowVerified(workspaceId, contractId, ctx)` — the direct-action wrapper. Fires bill_now AND schedules the verify. Returns `{ success, internal, pending, fired_at, subscription_id }`.
- `dispatchRecoveryOnDecline(input, deps?)` — **Phase 2** — fires the update-payment-method recovery journey exactly once for a declined verdict. Confirming-predicate guard: soft-skips when a `dunning.recovery_email_sent` `customer_events` row exists for this customer since `fired_at` (dunning's billing-failure path may already have delivered). Wraps [[./payment-recovery-email]]. Overridable `deps` (`alreadySentSinceFiredAt`, `sendRecovery`) make the guard + delivery testable without Resend / Supabase.
- `defaultRecoveryDispatchDeps()` — the production deps wiring (real `customer_events` count + `sendPaymentRecoveryEmail`). Extracted so tests swap either side cleanly.
- `computeConfirmationEndState(evidence): { ok, failed_checks }` — **Phase 4** — pure predicate. Returns `ok: true` iff EVERY end-state invariant holds: paid order found, non-zero line items, non-zero total, sub status `active`, sub last_payment_status `succeeded`. Names each failed check so the ledger stamp / escalation reason is human-readable. AND semantics — Sol only confirms when the full state matches "your order is on the way".
- `verifyConfirmationEndState(admin, opts)` — **Phase 4** — reader that hydrates `ConfirmationEndStateEvidence` from `subscriptions` + the most-recent paid `orders` row since `fired_at`, then calls the predicate. Returns `{ verdict, evidence }`.
- `dispatchConfirmationOnVerified(input, deps?)` — **Phase 4** — runs the end-state pass on a `paid` verdict. Returns `{ confirmed: true, evidence }` when Sol clears the state, or `{ confirmed: false, failed_checks, evidence }` when a drift blocks the confirmation. The Inngest fn uses this to pick between `verified_outcome='confirmed'` (unblocks the customer reply via [[./sol-outcome-claim-guard]]) and `verified_outcome='drifted'` (the completion gate escalates — Sol doesn't lie about the outcome).
- `defaultConfirmationDispatchDeps()` — the production deps wiring (real `verifyConfirmationEndState` against Supabase). Extracted so tests swap the reader cleanly.
- `dispatchOrderNowRetryOnMigrate(input, deps?)` — **Phase 3** — fires a DETERMINISTIC order-now retry on a freshly-migrated internal sub. No box / Sol session — the migrated sub is internal, so `subscriptionOrderNowVerified` triggers the Braintree renewal-attempt Inngest event synchronously and schedules the async verify to ground-truth the outcome (same Phase 1 → Phase 4 pipeline as any other order-now). Idempotency guard: soft-skips when a `commerce.order_now.retry_after_migrate` `customer_events` row exists for this subscription since `migrated_at` (blocks a double-charge on a re-drive of `vaultAndMigratePaymentMethod`). Overridable `deps` (`alreadyRetriedSinceMigrated`, `fireVerifiedOrderNow`, `logRetryEvent`) make the guard + fire testable without Supabase / Inngest.
- `defaultOrderNowRetryDeps()` — the production deps wiring (real `customer_events` count + `subscriptionOrderNowVerified` + `logCustomerEvent`). Extracted so tests swap any side cleanly.

## Verdict decision table

Checked in precedence order (first match wins):

| Evidence | Verdict |
|---|---|
| `hasNewPaidOrder` OR `hasBillingSuccessEvent` (STRONG paid signal) | `paid` |
| `hasBillingFailureEvent` OR `lastPaymentStatus='failed'` | `declined` |
| `hasNothingDueSkip` (pipeline no-op marker) | `nothing_due` |
| `lastPaymentStatus='succeeded'` (WEAK paid signal) | `paid` |
| None of the above | `unknown` (reschedule) |

A STRONG paid signal wins over a decline — a card rotation between fire and verify ends up with an ok account state; the ledger row reflects reality. `nothing_due` is checked BEFORE the WEAK `lastPaymentStatus='succeeded'` signal on purpose: an already-billed (spent) cycle leaves `last_payment_status='succeeded'` from the shipment that already went out, and that must NOT masquerade as a fresh paid order (ticket dd5e2ba0 — Ashley Denson, told her card would be charged $44.97 when nothing happened).

### nothing_due — skipped spent-cycle renewal

When `subscriptionOrderNow` fires a renewal-attempt for a customer-pressed order-now, it stamps `order_now: true` on the event. If the shopcx/internal renewal-attempt pipeline then resolves that attempt against an already-billed / not-yet-due cycle it skips WITHOUT charging and WITHOUT creating an order — a no-op the async verify can't otherwise observe. On those skip paths the pipeline calls `logOrderNowNothingDue` to write a `subscription.order_now_nothing_due` customer_event:

- **internal** ([[../inngest/internal-subscription-renewals]]) — the per-cycle idempotency claim refuses with `existing_status='succeeded'` (`refused_duplicate_cycle`): the current cycle already billed.
- **shopcx** ([[../inngest/shopify-subscription-renewals]]) — no chargeable cycle resolvable (`no_cycle_due`) or the cycle was already claimed (`cycle_already_claimed`).

`verifyOrderNowOutcome` reads that marker (scoped to `subscription_id` + the `fired_at` cursor) as `hasNothingDueSkip`, and the Inngest fn stamps `verified_outcome='nothing_due'` — a distinguishable, truthful terminal state. The ticket then confirms "no charge; this cycle already shipped; next order <date>" instead of a false "your order is processing" that used to loop on `unknown` → stale `drifted`.

## Wiring

- **Caller:** `directActionHandlers.bill_now` AND `order_now` in [[./action-executor]] both use `subscriptionOrderNowVerified`. On ANY successful fire (internal AND Appstle) they set `ctx._resolutionOutcomePending = true` so the executor's return-time `verified_outcome='confirmed'` stamp is SKIPPED — the async verify owns the verdict in every case. (Previously only Appstle `pending: true` deferred; internal stamped `confirmed` synchronously, which would win the idempotent compare-and-set and make a later `nothing_due` verdict impossible to land.)
- **Ledger stamp:** the Inngest function stamps `ticket_resolution_events.verified_at + verified_outcome` (`confirmed` | `nothing_due` | `drifted`) via a compare-and-set on `verified_at IS NULL` (idempotent — a re-drive can't overwrite an earlier verdict). `nothing_due` is permitted by the CHECK constraint via `supabase/migrations/20261008120000_ticket_resolution_events_verified_outcome_nothing_due.sql`.
- **Inngest event:** `commerce/order-now.verify` with `{ workspace_id, subscription_id, contract_id, fired_at, is_internal, resolution_event_id?, ticket_id?, customer_id?, attempt }`. Registered in [[../inngest/registered-functions]].
- **Renewal-attempt events:** `subscriptionOrderNow` stamps `order_now: true` on the `shopify-subscription/renewal-attempt` + `internal-subscription/renewal-attempt` events it fires (the nightly renewal cron omits it) so the pipelines can emit the `nothing_due` marker only for a genuine customer press.

## Phase sequencing

- **Phase 1 (landed):** async verify only — declined → stamp `drifted`.
- **Phase 2 (landed):** decline branch triggers the update-payment-method recovery journey via `dispatchRecoveryOnDecline` → [[./payment-recovery-email]]. Guarded so exactly one delivery lands per (customer, fired_at) window even when dunning's billing-failure webhook is racing us.
- **Phase 3 (landed):** journey completion migrates Appstle→internal ([[./vault-and-migrate-payment-method]]) and deterministically retries order-now on each migrated internal sub via `dispatchOrderNowRetryOnMigrate`. Called from `vaultAndMigratePaymentMethod` when `isRecovery` (or explicit `retryOrderNowOnMigrate`) is true — for each `migrated[]` entry the retry looks up the sub's post-migration `shopify_contract_id` (now internal), fires `subscriptionOrderNowVerified` (which triggers the Braintree renewal-attempt Inngest event synchronously and schedules the async verify), and logs `commerce.order_now.retry_after_migrate` on customer_events as the idempotency marker. A re-drive of `vaultAndMigratePaymentMethod` finds the marker and soft-skips — no double-charge. The internal renewal-attempt pipeline produces the real paid order that Phase 1's verify then reads.
- **Phase 4 (landed):** paid verdict runs Sol's end-state pass (`dispatchConfirmationOnVerified`) — only when EVERY invariant holds (paid order with items + non-zero total, sub active + last_payment_status='succeeded') does the ledger stamp `confirmed` and unblock the customer confirmation reply via [[./sol-outcome-claim-guard]]. A drifted end state stamps `drifted` with the failed checks, so [[./outcome-completion-gate]] escalates instead of Sol confirming a lie (message-is-last).
- **nothing_due (landed):** [[../specs/order-now-verify-nothing-due-verdict-for-skipped-spent-cycle]] — a distinguishable `nothing_due` verdict for an order-now the pipeline skips against an already-billed / not-yet-due cycle. Owner: [[../functions/cs]] (ticket-derived product fix; ticket dd5e2ba0 — Ashley Denson). See the *nothing_due — skipped spent-cycle renewal* section above.
- **Phase 5 (landed):** the end-to-end verify→recover→migrate→retry→confirm flow is now documented across [[../lifecycles/subscription-billing]] § Order-now (bill_now) (the primary trace + a Status/open work summary) and [[../lifecycles/dunning]] § Recovery email is also the order-now decline hand-off (why the recovery-email lane is shared with billing-failure dunning, and how the send-once guard prevents a double-send).

## See also

- [[./commerce__subscription]] — the underlying `subscriptionOrderNow` fire.
- [[./appstle]] — `orderNowByContract` + why Appstle is delayed.
- [[./payment-recovery-email]] — magic-link recovery email + tagged closed ticket the Phase 2 decline branch dispatches.
- [[../tables/ticket_resolution_events]] — the write-ahead ledger this library stamps.
- [[../lifecycles/subscription-billing]] · [[../lifecycles/dunning]] — the flows this library integrates with.
- [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] — the sibling message-is-last spec (Phase 4 integration point).
