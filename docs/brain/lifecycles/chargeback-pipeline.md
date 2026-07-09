# Chargeback pipeline

Shopify dispute → classify → auto-cancel subscriptions → ticket open + evidence reminder → won/lost outcome. The pipeline runs end-to-end on every dispute we receive, with admin overrides only at the classification + final outcome steps.

## Cast

- Source: Shopify Disputes API + Shopify `disputes/create` and `disputes/update` webhooks.
- State: [[../tables/chargeback_events]] + [[../tables/chargeback_subscription_actions]].
- Brain: [[../inngest/chargeback-processing]] + `src/lib/dunning.ts` (some shared helpers).
- Subscription mutations: [[../integrations/appstle]] (cancel with `cancellationFeedback="chargeback"`).
- Marketing: `src/lib/shopify-marketing.ts` (auto-unsubscribe).
- Customer comms: [[../integrations/resend]] (chargeback notice email if `chargeback_notify=true`).
- Settings: [[../tables/workspaces]] dunning + chargeback toggles.

## Workspace settings

[[../tables/workspaces]] holds the policy knobs:

- `chargeback_auto_cancel` (bool) — auto-cancel subs on incoming dispute matching the policy.
- `chargeback_auto_cancel_reasons` (text[]) — which dispute reason categories trigger auto-cancel. Default: `fraudulent`, `unrecognized`, `subscription_canceled`.
- `chargeback_notify` (bool) — send the customer a notice email.
- `chargeback_auto_ticket` (bool) — open a ticket for agent review.
- `chargeback_evidence_reminder` (bool) — schedule an evidence-due reminder.
- `chargeback_evidence_reminder_days` (int) — days before evidence due to remind.

## Phase 1 — dispute ingest

Shopify fires `disputes/create` webhook. Handler:

1. **Verify HMAC** against Client Secret.
2. **Match the order** by `shopify_order_id`.
3. **Insert [[../tables/chargeback_events]]** with `dispute_id`, `reason`, `status`, `amount_cents`, `due_by`, `customer_id`, `order_id`, `network` (Visa/MC/etc.).
4. **Fire Inngest** `chargebacks/dispute-received` → [[../inngest/chargeback-processing]].

`disputes/update` similarly upserts state changes — we keep the lifecycle (`needs_response` → `under_review` → `won` / `lost`) on the same row.

## Phase 2 — classification

The Inngest function classifies each chargeback into a category:

- `fraudulent` — true fraud (matches confirmed_fraud signals).
- `unrecognized` — customer doesn't remember the charge (subscription not associated with current expectations).
- `subscription_canceled` — customer thought sub was cancelled.
- `product_not_received` — delivery dispute.
- `product_unacceptable` — quality dispute.
- `duplicate` — double-charge claim.
- `credit_not_processed` — refund not received.
- `other` — fallback.

Map: `mapShopifyDisputeReasonToCategory()` in `src/lib/dunning.ts` (or a chargeback-specific helper). The category drives the auto-action policy.

## Phase 3 — auto-action

If `chargeback_auto_cancel=true` AND category ∈ `chargeback_auto_cancel_reasons`:

1. **Cancel all active subs** for the customer + linked accounts:
   - For each [[../tables/subscriptions]] in `status='active'` or `'paused'`:
     - Call [[../integrations/appstle]] `subscriptionContracts/{id}` DELETE with `cancellationFeedback="chargeback"` + `cancellationNote="Cancelled by system on ShopCX.ai — chargeback {dispute_id}"`.
     - Insert [[../tables/chargeback_subscription_actions]] row: `action='cancelled'`, `subscription_id`, `chargeback_event_id`.
2. **Auto-unsubscribe from marketing**:
   - Email: [[../integrations/shopify]] `customerEmailMarketingConsentUpdate` → unsubscribed.
   - SMS: same for `customerSmsMarketingConsentUpdate`.
3. **Record event** in [[../tables/chargeback_events]].`auto_action_taken='cancelled_subs_and_unsubscribed'`.
4. Tag the customer's most recent ticket (or a new ticket) `chargeback`.

If the category isn't in the auto-cancel list, the policy is `review` — open a ticket, leave subs active, wait for admin action.

## Phase 4 — ticket creation

If `chargeback_auto_ticket=true`, open a ticket in the chargeback queue:

- `channel='system'` or fall back to `email`.
- subject: "Chargeback received — {reason} — order {order_number}".
- Internal note with full dispute payload.
- `escalated_to` set to the chargeback owner (defaults to workspace owner).
- Tag `chargeback`.

This is the entry point for agents to upload evidence + decide a response.

## Phase 5 — evidence reminder

If `chargeback_evidence_reminder=true` and Shopify gave us a `due_by` timestamp:

1. Inngest schedules `step.sleepUntil(due_by - reminder_days)`.
2. On wake, post an internal note + a [[../tables/dashboard_notifications]] entry.
3. If still no evidence uploaded by `due_by - 1 day`, escalate to workspace owner.

## Phase 6 — outcome update

`disputes/update` posts again later with `status='won'` or `'lost'`:

- **Won** — Shopify reversed the dispute in our favor.
  - Update [[../tables/chargeback_events]].`status='won'`, `closed_at`.
  - **Reinstate cancelled subs** if `auto_action_taken='cancelled_subs_*'`:
    - For each [[../tables/chargeback_subscription_actions]] row → re-create the sub via Appstle (this is a manual action in practice — Appstle doesn't have a "reinstate" endpoint; admin reissues via the customer portal or migrates them to a fresh sub).
    - Insert action row `action='reinstated_manual'`.
  - Tag ticket `chargeback:won`. Close the ticket.
- **Lost** — Shopify ruled against us.
  - Update `status='lost'`, `closed_at`, `loss_amount_cents`.
  - Cancelled subs stay cancelled.
  - Marketing stays off.
  - Tag ticket `chargeback:lost`.
  - Forward to admin for follow-up (most workspaces also block the customer from future purchases).

## Phase 7 — fraud system intersection

Chargebacks **don't directly create [[../tables/fraud_cases]]**. They're feedstock for fraud signals — a customer with N+ lost chargebacks in M months looks fraudulent, but the formal fraud case requires a fraud rule match. See [[fraud-detection]].

The boundary: a chargeback is an evidence event, a fraud case is an active investigation. Two different states, two different tables. Don't merge them.

## Customer notice email

If `chargeback_notify=true`, send a templated email:

> "We received a dispute on your recent order [order_number]. Your subscription has been cancelled while we investigate. Reach out if this was a mistake."

Throttled by `customers.chargeback_notice_sent_at` — never more than once per customer per N days. Prevents spam in cases where multiple disputes land for the same customer in a short window.

## Audit + analytics

[[../tables/chargeback_events]] supports the chargebacks dashboard at `/dashboard/chargebacks` — list view with:

- Active subscription count column (sortable) — high-value chargebacks (customer had N active subs) sort first.
- Account linking shown in slideout.
- Won/lost/active filters.
- Per-reason buckets.

## Dispute polling fallback

Webhooks aren't 100%. [[../inngest/chargeback-processing]] also has a polling mode that hits Shopify's Disputes API daily to catch any disputes Shopify never delivered the webhook for. Compares against our existing [[../tables/chargeback_events]] rows and inserts any missing.

## Operational scripts

For one-off ops on a chargeback batch:

- `scripts/audit-issue-tickets.mjs` (if present) — sweep for chargeback tickets that should exist but don't.
- Manual reinstate via admin UI; no bulk script today.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/chargeback-processing.ts` | Per-dispute pipeline + polling fallback |
| `src/lib/shopify-webhooks.ts` | disputes/* webhook handlers |
| `src/lib/appstle.ts` | Subscription cancel with feedback=chargeback |
| `src/lib/shopify-marketing.ts` | Auto-unsubscribe |
| `src/lib/email.ts` | Chargeback notice template |
| `src/lib/ticket-tags.ts` | chargeback tags |
| `src/lib/dunning.ts` | Some shared error-code helpers |
| `src/app/dashboard/chargebacks/page.tsx` | List + slideout UI |
| `src/app/api/webhooks/shopify/route.ts` | Webhook entry |

## Status / open work

**Shipped:** Shopify disputes webhook ingestion + polling fallback, fraud-reason auto-cancel of subscriptions, evidence reminder, ticket creation, account linking on the dashboard chargeback detail — all functional.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** None.

## Related

[[fraud-detection]] · [[dunning]] · [[ticket-lifecycle]] · [[../integrations/shopify]] · [[../integrations/appstle]] · [[../integrations/resend]] · [[../libraries/shopify-webhooks]] · [[../tables/chargeback_events]] · [[../tables/chargeback_subscription_actions]] · [[../tables/subscriptions]] · [[../inngest/chargeback-processing]]
