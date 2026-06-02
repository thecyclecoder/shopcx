# braintree

Braintree — payment gateway for the custom storefront + our subscription billing (replaces Shopify Payments + Appstle). ~2.59% + 0.49 per transaction vs Shopify's ~2.9% + 0.30 + platform fee. Saves ~3% per order — see STOREFRONT.md.

## Auth

- **Encrypted on `workspaces`:**
  - `braintree_private_key_encrypted`
- **Plain on `workspaces`:**
  - `braintree_merchant_id`
  - `braintree_public_key`
  - `braintree_environment` — `sandbox` or `production`

Loaded by `getBraintreeGateway(workspaceId)` in `src/lib/integrations/braintree.ts`. Uses the official `braintree` npm SDK; no raw HTTP — all calls go through `Gateway`.

## Key SDK calls

| SDK call | Purpose |
|---|---|
| `clientToken.generate()` | Token for the browser Drop-in / Hosted Fields |
| `paymentMethod.create({ customerId, paymentMethodNonce, options: { verifyCard: true, makeDefault: true }})` | Vault a card at checkout. Returns `paymentMethodToken`. |
| `transaction.sale({ paymentMethodToken \| paymentMethodNonce, amount, customer, shipping, billing, options: { submitForSettlement: true, storeInVaultOnSuccess: true }})` | Charge a card (first-time + vaulted recurring) |
| `transaction.refund(transactionId, amount?)` | Partial or full refund |
| `transaction.void(transactionId)` | Void unsettled transaction |
| `customer.create({ ...email, phone, firstName, lastName })` | Create the gateway customer |

## Recurring billing

Vaulted `paymentMethodToken` stored on [[../tables/subscriptions]]. Inngest cron `subscription/billing-tick` selects subs with `next_billing_date <= now() + 1h`, recomputes line items + total, calls `transaction.sale({ paymentMethodToken, ... })`. On decline → triggers the existing dunning flow ([[../inngest/dunning]]) but against Braintree responses instead of Shopify's.

For SCA / 3DS: vaulted recurring sales use `external_vault.previous_network_transaction_id` to satisfy SCA exemptions.

## Rate limits + retry

- No published rate limit. SDK is generous; we don't backoff.
- SDK throws on transient errors. Caller decides — most code surfaces an error notification rather than retry.

## Webhooks

Braintree posts webhooks for disputes, recurring billing events, etc. Verified via `gateway.webhookNotification.parse(signature, payload)`. We use webhooks primarily for disputes (chargebacks) — see [[../tables/chargeback_events]].

## Gotchas

- **`payment_method_nonce` is one-time.** Pass it to `paymentMethod.create` to vault, then use the resulting `paymentMethodToken` for recurring. Don't try to reuse the nonce.
- **Card vault on first sale** with `storeInVaultOnSuccess: true` — but the safer pattern is vault-first via `paymentMethod.create({ verifyCard: true })`, then `transaction.sale({ paymentMethodToken })`. Two API calls; explicit fail fast.
- **`device_data`** must be passed from the browser SDK on first checkout for Kount fraud scoring. Without it, decline rates spike.
- **`makeDefault: true`** makes the new card the default for the customer; safe to pass since we want the most-recent card to be the primary recurring charge source.
- **`submitForSettlement: true`** is required; otherwise transactions stay `authorized` and need an explicit settlement.
- **3DS challenges** are handled by Hosted Fields — passing the 3DS-verified nonce is automatic. For recurring, set `external_vault.previous_network_transaction_id`.
- **Sandbox keys can't touch production data** (and vice versa). Flip `braintree_environment` carefully.
- **Decline codes** map to user-facing copy via [[../tables/dunning_error_codes]]. New codes → add a row, don't hardcode the message.

## Files

- `src/lib/integrations/braintree.ts` — `getBraintreeGateway()`, `refundBraintreeTransaction()`
- `src/lib/integrations/braintree-customer.ts` — Customer create/find helpers
- `src/app/api/checkout/route.ts` — Storefront checkout (vault + sale)

## Related

[[../tables/transactions]] · [[../tables/customer_payment_methods]] · [[../tables/orders]] · [[../tables/subscriptions]] · [[../tables/dunning_cycles]] · [[../tables/payment_failures]] · [[../tables/dunning_error_codes]] · [[../tables/chargeback_events]] · [[../inngest/dunning]] · [[../inngest/internal-subscription-renewals]]
