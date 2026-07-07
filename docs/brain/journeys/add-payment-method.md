# Add Payment Method

When a customer with no vaulted payment method adds one in-flow, this journey collects their card details, vaults it in [[../integrations/braintree]], sets it as the default, and migrates any remaining Appstle subscriptions to internal billing in one synchronous sequence.

DB row in [[../tables/journey_definitions]]: `slug='add_payment_method'`, `journey_type='payment_method'`, `trigger_intent='add_payment_method'`.

## Trigger

- **trigger_intent**: `add_payment_method`
- **match_patterns**: empty — prepended by the orchestrator when a customer is forced to add a card (e.g., failed recovery workflow, pre-dunning).
- **priority**: 100

## Channels

`email`, `chat`, `sms`. (Not `social_comments`, not `meta_dm`.)

## Steps

Built by `src/lib/add-payment-method-journey-builder.ts`:

1. **Enter card details** — Braintree Hosted Fields. Client token minted via `/api/journey/[token]/client-token`. Pre-fills cardholder name from the customer's profile.

## On submit

Calls [[../libraries/vault-and-migrate-payment-method]] `vaultAndMigratePaymentMethod`:

1. Resolve (or create) the customer's Braintree customer id — mirrors the portal's lookup pattern.
2. Vault the card via `vaultPaymentMethod` with `verifyCard + makeDefault`.
3. Save to [[../tables/customer_payment_methods]]; demote prior defaults in the link group.
4. **Migrate synchronously**: `migrateCustomerAppstleSubsToInternal` sweeps the customer's **active, paused, and cancelled** Appstle subs onto internal billing, preserving each sub's status. The customer is fully on internal billing before the journey signals done.

**Failure behavior:**
- Vault failure → throws 502. Session stays `in_progress` (fail closed) — no completion signal, client shows retry.
- Migration failure → logged but not re-thrown. The vault succeeded; we don't lose the card because one sub couldn't migrate. Matches the original portal handler behavior.

## Completion

On successful vault+migrate:
1. Compare-and-set transition: `['pending','in_progress'] → 'completed'` with `outcome='completed' + completed_at`. Gated on `workspace_id` — zero rows returned ⇒ concurrent completion, signal is NOT re-fired (exactly-once).
2. Write `payment_method_id`, `last4`, `card_brand`, `migrated_count` into [[../tables/tickets]].`playbook_context`.
3. Fire ONE `ticket/inbound-message` sentinel with body `"payment_method_added"` — the resume-after-journey mechanism (same signal as `shipping_address` → `"address_confirmed"`, `missing_items` → `"items_selected"`). Whitelisted in `unified-ticket-handler.ts` so it wakes a parked playbook.
4. Post identical internal + external ticket messages (parity across mini-site and live-chat).

`POST /api/journey/[token]/abandon` sets `status='abandoned'` without `outcome`, so abandoning does NOT emit the resume signal.

## Outcomes

| Tag | When |
|---|---|
| `j:add_payment_method` | Always |
| `jo:positive` | Card vaulted + migrated successfully |
| `jo:negative` | Customer abandoned mid-form |

## Step ticket status

`open`.

## Files

| File | Purpose |
|---|---|
| `src/lib/add-payment-method-journey-builder.ts` | Builder; single card-entry step |
| `src/lib/vault-and-migrate-payment-method.ts` | Shared vault → save → migrate sequence |
| `src/lib/migrate-to-internal.ts` | `migrateCustomerAppstleSubsToInternal` |
| `src/lib/integrations__braintree.ts` | `vaultPaymentMethod`, client token |
| `src/app/api/journey/[token]/submit-payment/route.ts` | Card submit endpoint |
| `src/app/api/journey/[token]/client-token/route.ts` | Braintree client token mint |
| `src/app/journey/[token]/page.tsx` | Mini-site form renderer |

## Related

[[../tables/journey_definitions]] · [[../tables/journey_sessions]] · [[../tables/customer_payment_methods]] · [[../integrations/braintree]] · [[../libraries/add-payment-method-journey-builder]] · [[../libraries/vault-and-migrate-payment-method]] · [[../libraries/migrate-to-internal]] · [[../lifecycles/customer-portal]] · [[../tables/tickets]]
