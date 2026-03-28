# Dunning System — Feature Spec

## Overview

Intelligent payment failure recovery that manages the entire retry lifecycle: card rotation across stored payment methods, payday-aware retry scheduling, automatic skip/unskip, and customer communication. Replaces Appstle's built-in retry/skip logic with a smarter system that recovers more revenue.

**Appstle config changes required before launch:**
- Turn OFF built-in payment retries (we manage them)
- Turn OFF built-in "skip after X failures" (we control skipping)
- We own the entire: fail → rotate cards → retry on paydays → skip → request update → unskip + bill flow

---

## Why This Matters

Payment failures are a major revenue leak. Industry benchmarks:
- No retry: 0% recovery
- Fixed schedule (4 retries): 50-60% recovery
- Smart/payday-aware retries + card rotation: 65-80% recovery
- Smart retries + dunning emails + card rotation: 75-85% recovery

The combination of trying all stored payment methods + timing retries around paydays + proactively requesting card updates is what gets recovery rates above 80%.

---

## Dunning Flow

### Phase 1: Payment Failure (Day 0)

Appstle webhook `subscription.billing-failure` fires.

1. Log to `payment_failures` table
2. Query customer's stored payment methods via Shopify GraphQL
3. Deduplicate cards (same last4 + same expiry = same card)
4. **Card rotation**: if other unique cards exist:
   - Switch subscription to next untried card via Appstle API
   - Trigger billing retry via Appstle API
   - Wait 2-4 hours between each card rotation attempt
   - Log each attempt (card tried, result)
5. Continue until a card succeeds or all cards exhausted

### Phase 2: All Cards Exhausted — First Cycle (Day 0-14)

All unique payment methods failed on initial rotation.

1. **Skip the order** via Appstle API
2. **Send payment update email** via Appstle API (triggers Shopify secure link)
3. **Send our own email**: "Your payment didn't go through. Click below to update your card and keep your subscription active."
4. **Schedule payday-aware retries**:
   - Find next upcoming payday dates: 1st, 15th, or Friday
   - On each payday: retry the most recently successful payment method
   - Retry at 6-8 AM in customer's timezone (or workspace timezone)
5. If any retry succeeds → log recovery, done
6. If still failing after 14 days → keep skip, wait for next billing cycle

### Phase 3: Customer Adds New Card (any time)

Shopify webhook `customer_payment_methods/create` or `customer_payment_methods/update` fires.

1. Check if customer has any subscriptions with active payment failures (skipped or paused due to dunning)
2. If yes:
   - **Unskip the order** via Appstle API
   - **Switch subscription to new payment method** via Appstle API
   - **Trigger billing immediately** via Appstle API
3. Log the recovery: "Payment recovered — customer added new card"
4. Send confirmation: "Your payment went through! Your subscription is back on track."

### Phase 4: Second Billing Cycle Fails (Cycle 2)

Next billing cycle fires, same card rotation + payday retries.

1. Same card rotation as Phase 1
2. Same payday-aware retries as Phase 2
3. If all fail after 14 days:
   - **Pause the subscription** via Appstle API
   - Send final email: "Your subscription is paused due to payment issues. Update your payment method to resume."
   - Create a **ticket** for agent awareness
   - Create a **dashboard notification**

---

## Payday-Aware Retry Scheduling

### US Payday Patterns
| Date/Day | Type | Priority |
|----------|------|----------|
| 1st of month | Semi-monthly pay | Highest |
| 15th of month | Semi-monthly pay | Highest |
| Fridays | Weekly/biweekly pay | High |
| Last business day of month | Monthly pay | High |
| Mondays | Weekend deposits cleared | Medium |

### Retry Logic
- After all cards exhausted, find the next 3 upcoming payday dates
- Schedule Inngest delayed steps (`step.sleepUntil`) for each
- On each payday retry: use the payment method that was most recently successful for this customer (query `payment_failures` for the last successful card)
- Retry at 6-8 AM (workspace timezone or default UTC-6 for US Central)
- If retry succeeds → cancel remaining scheduled retries

### Future Enhancement
Track which day of month each customer's payments historically succeed → retry on THEIR payday, not generic ones. Store in customer profile as `typical_payment_day`.

---

## Database Tables

### `payment_failures`
```sql
CREATE TABLE public.payment_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  subscription_id UUID REFERENCES subscriptions(id),
  shopify_contract_id TEXT NOT NULL,
  billing_attempt_id TEXT,
  payment_method_last4 TEXT,
  payment_method_id TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('initial', 'card_rotation', 'payday_retry', 'new_card_retry')),
  succeeded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_payment_failures_sub ON payment_failures(workspace_id, shopify_contract_id, created_at DESC);
CREATE INDEX idx_payment_failures_customer ON payment_failures(customer_id, succeeded);
```

### `dunning_cycles`
Tracks the overall dunning state per subscription per billing cycle.
```sql
CREATE TABLE public.dunning_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id),
  shopify_contract_id TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  cycle_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('active', 'skipped', 'paused', 'recovered', 'exhausted')),
  cards_tried TEXT[] DEFAULT '{}',
  payment_update_sent BOOLEAN DEFAULT false,
  payment_update_sent_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  billing_attempt_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_dunning_cycles_active ON dunning_cycles(workspace_id, status, customer_id);
CREATE UNIQUE INDEX idx_dunning_cycles_contract ON dunning_cycles(workspace_id, shopify_contract_id, cycle_number);
```

### Workspace columns (add to workspaces table)
```sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_enabled BOOLEAN DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_max_card_rotations INTEGER DEFAULT 6;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_payday_retry_enabled BOOLEAN DEFAULT true;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_cycle_1_action TEXT DEFAULT 'skip';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dunning_cycle_2_action TEXT DEFAULT 'pause';
```

---

## Appstle API Endpoints

| Action | Method | Endpoint |
|--------|--------|----------|
| Get upcoming orders | GET | `/subscription-billing-attempts/top-orders?contractId={id}` |
| Trigger billing retry | PUT | `/subscription-billing-attempts/attempt-billing/{billingAttemptId}` |
| Skip order | PUT | `/subscription-billing-attempts/skip-upcoming-order?contractId={id}` |
| Unskip order | PUT | `/subscription-billing-attempts/unskip-order/{billingAttemptId}` |
| Switch payment method | PUT | `/subscription-contracts-update-existing-payment-method?contractId={id}` + body `{"paymentMethodId": "gid://..."}` |
| Send payment update email | PUT | `/subscription-contracts-update-payment-method?contractId={id}` |

All require header: `X-API-Key: {api_key}`

**Note**: `attempt-billing` requires `enableImmediatePlaceOrder` permission in Appstle settings.

## Shopify GraphQL

### Get customer payment methods
```graphql
query customerPaymentMethods($customerId: ID!) {
  customer(id: $customerId) {
    paymentMethods(first: 10) {
      edges {
        node {
          id
          instrument {
            ... on CustomerCreditCard {
              lastDigits
              expiryMonth
              expiryYear
              brand
              name
            }
            ... on CustomerShopPayAgreement {
              lastDigits
              expiryMonth
              expiryYear
              name
            }
          }
          revokedAt
        }
      }
    }
  }
}
```
Filter out revoked methods (`revokedAt != null`). Deduplicate by `lastDigits + expiryMonth + expiryYear`.

### Send payment update email (Shopify native)
```graphql
mutation {
  customerPaymentMethodSendUpdateEmail(
    customerPaymentMethodId: "gid://shopify/CustomerPaymentMethod/abc123"
  ) {
    customer { id }
    userErrors { field message }
  }
}
```
Fallback if Appstle's send-update endpoint doesn't work for some reason.

### Subscription billing attempt (Shopify native fallback)
```graphql
mutation subscriptionBillingAttemptCreate($contractId: ID!, $input: SubscriptionBillingAttemptInput!) {
  subscriptionBillingAttemptCreate(
    subscriptionContractId: $contractId
    subscriptionBillingAttemptInput: $input
  ) {
    subscriptionBillingAttempt { id ready }
    userErrors { field message }
  }
}
```
Use if Appstle's `attempt-billing` endpoint is insufficient.

---

## Webhook Handlers

### Existing: `subscription.billing-failure` (Appstle)
Currently handled in `src/app/api/webhooks/appstle/[workspaceId]/route.ts` — updates `last_payment_status` to "failed". Needs to be extended to trigger the dunning flow.

### Existing: `subscription.billing-success` (Appstle)
Already resets `consecutive_skips`. Needs to also close any active dunning cycle.

### New: `customer_payment_methods/create` (Shopify)
Need to register this webhook topic. When fired:
1. Check if customer has active dunning cycles
2. If yes → unskip + switch card + retry billing

### New: `customer_payment_methods/update` (Shopify)
Same as create — customer may have updated an existing card's details.

---

## Inngest Functions

### `dunning/payment-failed`
Triggered by billing-failure webhook. Orchestrates the full dunning flow:
1. `step.run("log-failure")` — record to payment_failures
2. `step.run("get-payment-methods")` — query Shopify for stored cards
3. `step.run("rotate-card-1")` → `step.sleep("2h")` → `step.run("rotate-card-2")` → etc.
4. `step.run("all-cards-exhausted")` — skip order + send emails
5. `step.sleepUntil("next-payday")` → `step.run("payday-retry-1")` → etc.

### `dunning/new-card-recovery`
Triggered by payment method create/update webhook:
1. `step.run("check-dunning-cycles")` — find active dunning for this customer
2. `step.run("unskip-order")` — via Appstle
3. `step.run("switch-payment-method")` — via Appstle
4. `step.run("retry-billing")` — via Appstle
5. `step.run("notify-recovery")` — internal note + customer email

### `dunning/billing-success`
Triggered by billing-success webhook when a dunning cycle is active:
1. Update dunning_cycle status to "recovered"
2. Close any scheduled retry steps
3. Log recovery to payment_failures (succeeded = true)

---

## Customer Communication

| Event | Email | Internal Note |
|-------|-------|---------------|
| First failure | None (silent card rotation) | "[System] Payment failed on card ending {last4}. Trying other payment methods." |
| Card rotation succeeds | None | "[System] Payment recovered using card ending {last4}" |
| All cards fail + skip | "Your payment didn't go through. Update your card: [link]" | "[System] All payment methods failed. Order skipped. Payment update email sent." |
| Payday retry succeeds | "Your payment went through!" | "[System] Payment recovered on payday retry using card ending {last4}" |
| Customer adds new card → recovery | "Your payment went through! Your order is on its way." | "[System] Customer added new card. Order unskipped and billed successfully." |
| Cycle 2 all fail + pause | "Your subscription is paused. Update your payment method to resume: [link]" | "[System] Payment failed on all methods for 2 consecutive cycles. Subscription paused." |

---

## Settings UI

### Settings → Dunning (or Settings → Subscriptions → Dunning)
- **Enable/disable** dunning management
- **Max card rotations** per cycle (default: 6)
- **Payday retries** toggle (default: on)
- **Cycle 1 action**: skip order (default)
- **Cycle 2 action**: pause subscription (default)
- **Email templates**: customize the dunning emails (or use defaults)

---

## Tags

- `dunning:active` — active dunning cycle on this ticket's customer
- `dunning:recovered` — payment recovered through dunning
- `dunning:skipped` — order was skipped due to payment failure
- `dunning:paused` — subscription paused due to repeated payment failure

---

## Files to Create

| File | Purpose |
|------|---------|
| `supabase/migrations/YYYYMMDD_dunning.sql` | payment_failures, dunning_cycles tables + workspace columns |
| `src/lib/dunning.ts` | Core dunning logic: card rotation, payment method dedup, retry scheduling |
| `src/lib/inngest/dunning.ts` | Inngest functions: payment-failed, new-card-recovery, billing-success |
| `src/app/api/webhooks/shopify/payment-methods/route.ts` | Shopify payment method create/update webhook handler |
| `src/app/dashboard/settings/dunning/page.tsx` | Dunning settings UI |

## Files to Modify

| File | Change |
|------|--------|
| `src/app/api/webhooks/appstle/[workspaceId]/route.ts` | Extend billing-failure handler to trigger dunning |
| `src/lib/appstle.ts` | Add: attemptBilling, skipUpcomingOrder, unskipOrder, switchPaymentMethod, sendPaymentUpdateEmail |
| `src/lib/shopify-sync.ts` or new `src/lib/shopify-payments.ts` | Add: getCustomerPaymentMethods GraphQL query |
| `src/lib/email.ts` | Add: sendDunningEmail templates |
| `src/lib/inngest/client.ts` | Register new dunning Inngest functions |
| `CLAUDE.md` | Update with dunning system docs |

---

## Recovery Metrics

Track in dashboard (future analytics page):
- **Recovery rate**: % of failed payments eventually recovered
- **Card rotation recovery rate**: % recovered by trying another stored card
- **Payday retry recovery rate**: % recovered by payday-timed retries
- **New card recovery rate**: % recovered after customer added new card
- **Average time to recovery**: days from first failure to successful charge
- **Revenue recovered**: total $ recovered through dunning
- **Churn prevented**: subscriptions that would have been lost without dunning
