# Dunning lifecycle

When a subscription's billing attempt fails, we don't immediately email the customer "your payment failed." We try to recover silently first — card rotation, payday retries — and only escalate to the customer when self-healing won't work. This page traces the full state machine from the failed billing webhook to either silent recovery, customer-driven recovery, or eventual pause.

## Cast

- Trigger: Shopify `billing_attempt_failure` webhook → handler in `src/lib/dunning-webhook.ts`.
- Brain: [[../inngest/dunning]] — four functions: payment-failed, new-card-recovery, billing-success, payday-retry-cron.
- State: [[../tables/dunning_cycles]] (per-billing-cycle), [[../tables/payment_failures]] (per-attempt).
- Card source: dunning rotation reads cards **live** from Shopify (`getCustomerPaymentMethods()` in `src/lib/dunning.ts`). Separately, the payment-method webhook mirrors them into [[../tables/customer_payment_methods]] (`provider='shopify'`) for portal/dashboard/orchestrator visibility — that table is NOT what rotation reads.
- Subscription mutations: [[../integrations/appstle]].
- Customer comms: [[../integrations/resend]] (payment update + recovery + paused emails).
- Settings: [[../tables/workspaces]] (`dunning_enabled`, `dunning_max_card_rotations`, `dunning_payday_retry_enabled`, `dunning_cycle_1_action`, `dunning_cycle_2_action`).

## Phase 1 — failure capture

Shopify fires the webhook. The handler in `src/lib/dunning-webhook.ts`:

1. Verifies HMAC against the shop's Client Secret.
2. Loads the workspace's [[../tables/workspaces]] dunning settings. If `dunning_enabled = false`, bail.
3. Looks up the [[../tables/subscriptions]] row by `shopify_contract_id`. Internal subs (via `is_internal=true`) bypass Appstle entirely.
4. Finds or creates the active [[../tables/dunning_cycles]] row for this (subscription, billing cycle):
   - If an active cycle exists, this is a retry within an in-flight cycle.
   - If not, a new cycle starts at `status='active'`, `cycle_number = previous_cycle + 1`.
5. Logs the attempt to [[../tables/payment_failures]] with `attempt_type='initial'`, the error code, and the card last4.
6. Fires Inngest `dunning/payment-failed` with `workspace_id`, `subscription_id`, `customer_id`, `cycle_id`, `error_code`, `error_message`.

Returns 200. From here on it's Inngest.

## Phase 2 — card rotation (silent recovery)

[[../inngest/dunning]] `dunning-payment-failed` (retries=2, concurrency limit 3 per workspace):

1. **Check settings** — already loaded once at webhook time, reloaded here for durability.
2. **Load the cycle** + **load all cards** from [[../tables/customer_payment_methods]] (which is a Shopify `customerPaymentMethods` snapshot). Deduplicate via `deduplicatePaymentMethods()` — same `(last4, expiry_month, expiry_year, card_brand)` collapses to one logical card even if Shopify has multiple `paymentMethodToken`s.
3. **Identify untried cards** for this cycle: cards not yet recorded in [[../tables/payment_failures]] for this `cycle_id` (excluding `attempt_type='initial'`).
4. **If untried card exists and rotation count < `dunning_max_card_rotations`** (default 3):
   - Call [[../integrations/appstle]] `subscription-contracts-update-existing-payment-method` to swap the card.
   - Call `subscription-billing-attempts/attempt-billing/{billing_attempt_id}` to force a retry.
   - Wait 2 hours via `step.sleep`.
   - On next failure, the webhook re-fires → we land back here with a new `payment_failures` row tagged `attempt_type='card_rotation'`.
5. **If all cards exhausted** → fall through to payday retries.

Customer sees nothing during this phase — it's silent.

## Phase 3 — payday retries

If cards are exhausted, the payday-retry path takes over (only if `dunning_payday_retry_enabled = true`):

1. **Send the payment-update email** via [[../integrations/resend]] — `sendDunningPaymentUpdateEmail`. This is the customer's first touch in the dunning flow.
2. **Compute the next payday-aligned retry date** via `getNextPaydayDates()`: 1st of month, 15th, every Friday, last business day of month. Pick the soonest. All at 7 AM Central.
3. **Schedule via `step.sleepUntil`** until that date.
4. **At wake-up**: call `appstleAttemptBilling`. Log to [[../tables/payment_failures]] with `attempt_type='payday_retry'`.
5. **On success** → `dunning/billing-success` fires (see Phase 5).
6. **On failure** → loop back to step 2 with the next payday date.

Up to N payday retries (configurable; default 4). After exhaustion, fall through to cycle action.

## Phase 4 — cycle action

After silent rotation AND payday retries both fail, the cycle action defined in [[../tables/workspaces]] kicks in:

- **Cycle 1 default — `skip`**: call [[../integrations/appstle]] `subscription-contracts-skip` for the next order. The customer doesn't get charged but the sub stays active. Tag the ticket `dunning:skipped`. The customer's NEXT billing attempt (one cycle later) restarts the whole dunning flow.
- **Cycle 2 default — `pause`**: call `appstleSubscriptionAction("pause")`. Send `sendDunningPausedEmail`. Open a ticket. Add a [[../tables/dashboard_notifications]] entry. Tag `dunning:paused`.

The Cycle 1 action can also be configured to pause; Cycle 2 can be configured to cancel. Set in Settings → Dunning.

The cycle row updates to `status='exhausted'` after action is taken.

## Phase 5 — new-card recovery (customer-driven)

If during ANY of the above, the customer updates their card in Shopify:

1. Shopify fires `customer_payment_methods/create` or `customer_payment_methods/update` webhook.
2. Handler in `src/lib/dunning-webhook.ts`:
   - **Mirrors the card** into [[../tables/customer_payment_methods]] via `syncShopifyPaymentMethods()` (`provider='shopify'`) so the portal / dashboard / orchestrator can see it. Dunning rotation reads cards live from Shopify, but everything else reads this table, and it was Braintree-only before — so Appstle customers' cards were invisible until captured here.
   - Checks for recoverable dunning cycles ([[../tables/dunning_cycles]] `status IN ('active','skipped','exhausted')`).
3. If any → fires `dunning/new-card-recovery`.

**Gotcha (why this used to silently fail):** the cycle filter previously only matched `active`/`skipped`. But a sub that dunning *cancelled* leaves its cycle `exhausted` — so adding a card after cancellation never fired recovery, even though the recovery function is explicitly built to reactivate dunning-cancelled subs (Step 1b). `exhausted` is now included. (Fixed 2026-06-09.)

[[../inngest/dunning]] `dunning-new-card-recovery`:

1. **Switch card** on the subscription via [[../integrations/appstle]].
2. **Unskip the upcoming order** if previously skipped (`appstleUnskipOrder`).
3. **Force a billing attempt** (`appstleAttemptBilling`).
4. On success → `dunning/billing-success` → tag `dunning:recovered`, send `sendDunningRecoveryEmail`.
5. On failure → we go back into card rotation (rare — the customer just added a card, so it usually works).

This is the happy path: customer sees one payment-update email, clicks the link, adds a card, gets a "you're all set" confirmation.

## Phase 6 — success cleanup

[[../inngest/dunning]] `dunning-billing-success` fires when ANY successful billing happens on a sub that had an active dunning cycle:

1. Update [[../tables/dunning_cycles]] `status='recovered'`, `recovered_at=now()`.
2. If the customer's sub was paused mid-cycle, resume it (status check first — don't re-resume a sub the customer manually paused).
3. Tag ticket `dunning:recovered`. Drop the `dunning:active` tag.
4. Update [[../tables/customers]] retention score if applicable.

The cycle is closed. The customer sub returns to normal billing rhythm.

## Per-attempt log

Every card try writes to [[../tables/payment_failures]]:

| `attempt_type` | When |
|---|---|
| `initial` | First webhook firing — the customer's stored card declined |
| `card_rotation` | Silent swap to another stored card |
| `payday_retry` | After cards exhausted, on a payday-aligned date |
| `new_card_retry` | Customer added a new card |

Querying this table reveals retry patterns + failure-code distribution — feeds the dunning analytics dashboard. Errors are categorized via [[../tables/dunning_error_codes]] (insufficient_funds, expired_card, hard_decline, etc.).

## Terminal error codes

`isTerminalErrorCode()` in `src/lib/dunning.ts` short-circuits the flow for codes like `card_blocked`, `do_not_honor` after first occurrence — no point rotating to other cards from the same customer if the bank has hard-blocked transactions. Direct-jump to the cycle action.

## Gotcha: Appstle `contract-external` returns a stale status after a write

Right after `appstleSubscriptionAction(resume/pause/cancel)`, reading `subscription-contracts/contract-external/{id}` can return the **pre-change** status for a short window (Appstle eventual consistency). Don't use that read to verify a status change succeeded — it produces false negatives (we briefly believed a successfully-resumed sub was still `CANCELLED`). The authoritative signal that a resume worked is that `top-orders` returns a fresh QUEUED billing schedule. A `resume` on a dunning-cancelled contract **does** reactivate it (confirmed in the Appstle UI) — the contract is not terminal the way a raw Shopify cancel would be.

## Appstle settings that must be OFF

This whole engine assumes Appstle's built-in dunning is disabled:

- Appstle's "retry failed payments" → OFF
- Appstle's "skip after X failures" → OFF

If either is on, our pipeline and Appstle's will fight — both skipping the same order, both rotating cards, both emailing the customer. See CLAUDE.md § Phase 5.

## Tags applied

- `dunning:active` — open dunning cycle
- `dunning:recovered` — payment recovered
- `dunning:skipped` — Cycle 1 action: order skipped
- `dunning:paused` — Cycle 2 action: sub paused

All via `src/lib/ticket-tags.ts` (idempotent).

## Slack notifications

`dispatchSlackNotification()` ([[../integrations/inngest]]) fires Slack alerts on:

- New dunning cycle starts (info)
- Cycle 2 pause action taken (warning — customer-impacting)
- Recovery (positive)

Configured per workspace in [[../tables/slack_notification_rules]].

## Files touched

| File | Purpose |
|---|---|
| `src/lib/dunning.ts` | Core logic — card dedup, payday scheduling, settings, cycle CRUD, error-code categorization |
| `src/lib/dunning-webhook.ts` | Shopify `billing_attempt_failure` + `customer_payment_methods/*` webhook handlers |
| `src/lib/inngest/dunning.ts` | Orchestration — payment-failed, new-card-recovery, billing-success, payday-retry-cron |
| `src/lib/appstle.ts` | All Appstle calls: attempt-billing, skip, unskip, switch-payment-method, pause |
| `src/lib/email.ts` | sendDunningPaymentUpdateEmail / RecoveryEmail / PausedEmail |
| `src/lib/ticket-tags.ts` | Tag helpers |
| `src/lib/slack-notify.ts` | Slack alerts |
| `src/app/api/webhooks/shopify/route.ts` | Webhook entry point |
| `src/app/dashboard/settings/dunning/page.tsx` | Settings UI |

## Status / open work

**Shipped:** Silent card rotation (`deduplicatePaymentMethods`), payday-aware retries (`getNextPaydayDates` — 1st/15th/Fridays/last-business-day), Cycle 2 cancel-instead-of-pause + auto-reactivate, customer-driven new-card recovery, terminal-card cancel-without-entering-dunning, replacement-of-Appstle-payment-update-email — all functional.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- Payment-method webhook now (a) mirrors Shopify cards into customer_payment_methods (`provider='shopify'`) and (b) fires new-card-recovery for `exhausted` (dunning-cancelled) cycles, not just active/skipped — so adding a card after cancellation auto-reactivates. (2026-06-09)
- `84eefddd` Drop Appstle payment-update email; restyle ours to look human
- `d3a1ae28` Terminal+single-card billing failure: cancel without entering dunning
- `39a1232e` Dunning cycle 2: cancel instead of indefinite pause + auto-reactivate

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[chargeback-pipeline]] · [[subscription-billing]] · [[../integrations/appstle]] · [[../integrations/shopify]] · [[../integrations/resend]] · [[../tables/dunning_cycles]] · [[../tables/payment_failures]] · [[../tables/customer_payment_methods]] · [[../inngest/dunning]]
