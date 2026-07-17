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

### Early terminal + no-backup cancel
`cancelForTerminalNoBackup` (`src/lib/dunning.ts`, called from the Appstle webhook's early path) handles **terminal error + ≤1 payment method**: there's nothing to rotate to, so it cancels the sub + sends the recovery email immediately, skipping the rotation/retry phases.

**Gotcha (fixed 2026-06-16):** this path used to create **no dunning cycle**. But new-card recovery's reactivation (`reactivateDunningCancelledSubs`) only reactivates a cancelled sub that has a cycle in `[exhausted, cancelled]`. So a customer cancelled via this path who later recovered with a working card was **migrated to internal but never reactivated or charged → no order** — even though the recovery email promised exactly that. `cancelForTerminalNoBackup` now records an **`exhausted`** cycle (with `terminal_error_code`) at cancel time so recovery can fulfill the promise. (Only customer hit before the fix: gerkenjeanie@yahoo.com — manually backfilled: exhausted cycle → reactivate the one failed sub → charge → order. The customer's other cancelled subs had no payment failure, so they correctly stayed cancelled.)

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

## Internal-sub dunning (Braintree-billed)

The machinery above is **Appstle-only** — card rotation, Shopify billing-attempts, and the `billing-failure`/`-success` webhooks don't exist for internal (Braintree) subs. Internal subs get a parallel path in `src/lib/inngest/internal-dunning.ts` ([[../inngest/internal-dunning]]):

- **Entry:** `internal-subscription-renewals.ts` decline fires a **complete** `dunning/payment-failed` (`source: "internal_subscription_renewal"`, `shopify_contract_id` = the `internal-*` id, Braintree `error_code`) **and** logs a `customer_events` `subscription.payment_failed` immediately (timeline + AI see it regardless of dunning's outcome).
- **Router:** `dunning.ts` `dunningPaymentFailed` branches on `source === "internal_subscription_renewal"` at the very top → `handleInternalDunningFailure` (skips all Appstle/Shopify logic).
- **Retry engine = the daily renewal cron.** On failure the handler moves the sub's `next_billing_date` to the next payday (`getNextPaydayDates`); `internalSubscriptionRenewalCron` re-attempts then. No Appstle billing-attempt. Cycle status → `retrying`, `next_retry_at` set.
- **Email timing:** recovery magic-link sent **immediately on the first *terminal* Braintree decline** (`BRAINTREE_TERMINAL` set — expired/closed/invalid card); soft declines (insufficient funds) wait until retries exhaust (`MAX_PAYDAY_RETRIES = 4`), then email.
- **Exhaustion:** sub **cancelled** (`subscription.cancelled` event, reason `dunning_exhausted`) + recovery email. Cancelled-by-dunning ≠ voluntary cancel: it has an `exhausted` dunning cycle.
- **Recovery:** `payment-method-update.ts` recover flow calls `reactivateDunningCancelledSubs` (keyed on an exhausted/cancelled cycle, never voluntary cancels) → sub back to `active`, cycle → `recovered`, new card pinned in the same pass.
- **Cycle close:** a **successful** internal renewal calls `closeInternalDunningOnSuccess` (no webhook to do it) → cycle `recovered` + `payment.recovered` event.
- **AI visibility:** `getDunningStatus` (`get_dunning_status` tool) now surfaces `(internal)`, recovery-link-sent status, and `next_retry_at` so the agent can say "I've already sent you a link to update your card."

## Recovery email + post-update charge (all dunning paths)

Both the legacy Appstle dunning and the internal path now send **one shared** recovery email via `src/lib/payment-recovery-email.ts` `sendPaymentRecoveryEmail(workspaceId, customerId)` — replacing the old static `portal_config.general.payment_update_url`:

- **Magic link** (`generatePaymentRecoveryLink`, 7-day) → auto-login → `/payment-methods?recover=1`. No static account page.
- **Creates a tagged, CLOSED ticket** (tag `payment-recovery`, channel `email`) + an outbound `ticket_message`, with the email's **Message-ID stored as the ticket `email_message_id`**.
- **Reply-To = `inbound@updates.superfoodscompany.com`** (override `DUNNING_INBOUND_REPLY_TO`) so a customer reply threads back onto that ticket (via the Message-ID, or the inbound webhook's subject + same-customer fallback). The closed ticket re-opens on reply.
- Writes a `dunning.recovery_email_sent` customer_event.

**On card update (`payment-method-update.ts` recover flow):** vault → **migrate the link group's Appstle subs to internal** (`migrateCustomerAppstleSubsToInternal`, which cancels each Appstle contract *before* flipping — see below) → pin the new card → **reactivate** dunning-cancelled subs (`reactivateDunningCancelledSubs`, returns the ids) → **charge now**: fire `internal-subscription/renewal-attempt` for every sub that was failing (open dunning cycle) or just reactivated, so the missed payment is collected immediately instead of waiting for the next scheduled renewal. Healthy subs (no dunning cycle) are never charged. A successful renewal closes the cycle via `closeInternalDunningOnSuccess`, which now looks the cycle up by **`subscription_id`** (not contract id) so a cycle opened on the *old Appstle* contract still closes after the recovery flip.

**Never double-billed:** migration cancels the Appstle contract **first**; if the cancel fails the sub is NOT flipped (stays Appstle-only), so a sub is never live on both Appstle and internal. The flip also drops the Appstle contract id and the Appstle webhook ignores `is_internal` subs. The migration writes a `subscription.migrated` customer_event to the timeline.

## Recovery email is also the order-now decline hand-off (send-once with dunning)

An Appstle `order-now` / `bill_now` that ACKs then declines lands in the same recovery lane as a scheduled-renewal billing-failure — same magic-link recovery email, same vault → migrate → charge post-update pipeline (above). This is Phase 2 of [[../specs/order-now-verify-async-result-then-decline-recovery-migrate-and-deterministic-retry]] (Judy, ticket 0a9e4d7f): [[../libraries/order-now-verify]] `dispatchRecoveryOnDecline` fires `sendPaymentRecoveryEmail` on a `declined` verdict.

**Send-once invariant.** Both the dunning-webhook path (Phase 1 above) AND the order-now decline dispatcher can race to send the recovery email for the SAME customer + SAME billing failure. To avoid a double-send, `dispatchRecoveryOnDecline` consults a confirming-predicate guard — it counts `dunning.recovery_email_sent` [[../tables/customer_events]] rows for that customer since the order-now `fired_at`, and soft-skips if the dunning webhook already delivered. Blast radius on the residual race (both sides sending in the same window) is at most one duplicate email — the magic link is idempotent from the customer's POV (same recovery ticket tag, same portal deep-link).

**On card update, order-now retries deterministically on the migrated (internal) rail.** After the recover flow migrates the sub Appstle→internal and reactivates it (above), the order-now retry runs in plain Node against the deterministic Braintree pipeline — no box/Sol session needed, immediate charge, idempotency-guarded so a re-drive can't create a second order. Only a verified paid order (Sol's end-state pass — items present, non-zero total, sub active, `last_payment_status='succeeded'`) unblocks the customer confirmation reply via [[../libraries/sol-outcome-claim-guard]]; a drifted end state escalates via [[../libraries/outcome-completion-gate]] instead of sending a false "your order shipped." See [[subscription-billing]] § Order-now (bill_now) for the full flow trace.

## Status / open work

**Shipped:** Silent card rotation (`deduplicatePaymentMethods`), payday-aware retries (`getNextPaydayDates` — 1st/15th/Fridays/last-business-day), Cycle 2 cancel-instead-of-pause + auto-reactivate, customer-driven new-card recovery, terminal-card cancel-without-entering-dunning, replacement-of-Appstle-payment-update-email, **internal-sub dunning (Braintree, payday-retry via renewal cron, magic-link recovery, cancel+reactivate, AI visibility)**, **transient-Shopify-error resilience (retry-on-5xx/429/network)** — all functional.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `getCustomerPaymentMethods` now retries on Shopify GraphQL 5xx/429/network transients (3 retries, 1-2s backoff) — transient upstream blips no longer surface as "zero payment methods" → exhausted cycle. Mirrors `fetchWithRetry` from [[../libraries/shopify-sync]]. (2026-07-17)
- Order-now (bill_now) async verify + decline hand-off ([[../specs/order-now-verify-async-result-then-decline-recovery-migrate-and-deterministic-retry]], derived from ticket 0a9e4d7f — Judy): an Appstle bill_now decline now shares the recovery-email lane with the scheduled-renewal path — [[../libraries/order-now-verify]] `dispatchRecoveryOnDecline` fires `sendPaymentRecoveryEmail` on a `declined` verdict, guarded against the dunning-webhook double-send via a `dunning.recovery_email_sent` [[../tables/customer_events]] count since `fired_at`. Post-update the sub migrates → internal and the order-now retry runs deterministically; only a verified paid order (Sol's end-state pass) unblocks the customer confirmation reply ([[../libraries/sol-outcome-claim-guard]]). See § Recovery email is also the order-now decline hand-off above + [[subscription-billing]] § Order-now (bill_now). (2026-07-08)
- Control Tower **stuck-dunning** assertion ([[../libraries/control-tower]], [[../specs/control-tower-renewal-integrity-assertions]] P1): the `dunning-payday-retry-cron` tile flips red when any [[../tables/dunning_cycles]] row is still `retrying` >48h past `next_retry_at` — the retry engine ran but isn't advancing it to recovered/exhausted. A sub correctly mid-dunning (within its retry schedule) is NOT flagged. Pairs with the renewal-cron outcome-distribution assertion (decline/no-PM-skip spike). (2026-06-22)
- Internal-sub dunning shipped: internal renewal failures now enter dunning, retry on the payday schedule (renewal cron is the engine), email the magic-link recovery flow (terminal-now / soft-after-exhaust), cancel-on-exhaust + reactivate-on-recovery, and flow through `customer_events` for timeline + AI. (2026-06-09)
- Payment-method webhook now (a) mirrors Shopify cards into customer_payment_methods (`provider='shopify'`) and (b) fires new-card-recovery for `exhausted` (dunning-cancelled) cycles, not just active/skipped — so adding a card after cancellation auto-reactivates. (2026-06-09)
- `84eefddd` Drop Appstle payment-update email; restyle ours to look human
- `d3a1ae28` Terminal+single-card billing failure: cancel without entering dunning
- `39a1232e` Dunning cycle 2: cancel instead of indefinite pause + auto-reactivate

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[chargeback-pipeline]] · [[subscription-billing]] · [[../integrations/appstle]] · [[../integrations/shopify]] · [[../integrations/resend]] · [[../tables/dunning_cycles]] · [[../tables/payment_failures]] · [[../tables/customer_payment_methods]] · [[../inngest/dunning]]
