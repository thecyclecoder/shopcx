# libraries/vault-and-migrate-payment-method

Shared vault → save → migrate sequence for a Braintree nonce. The single code path both the portal's "add a card" handler and the `add_payment_method` mini-site journey call, so the two flows never drift.

**File:** `src/lib/vault-and-migrate-payment-method.ts`

## File header

```
Vault a Braintree nonce and (by default) migrate the customer's Appstle subs
to internal in one synchronous sequence — the "strangler migration" step.

Migration ordering = Option A migrate-first (per spec § Phase 2): vault →
save → migrate → return. The customer is fully on internal billing before
the caller signals done.
```

## Exports

### `vaultAndMigratePaymentMethod(input): Promise<VaultAndMigrateResult>` — function

```ts
async function vaultAndMigratePaymentMethod(input: VaultAndMigrateInput): Promise<VaultAndMigrateResult>
```

**Sequence:**
1. Resolve the Braintree customer id — prefer an existing `customer_payment_methods.braintree_customer_id`; else `resolveBraintreeCustomerId` (the same helper checkout uses).
2. `vaultPaymentMethod(workspaceId, braintreeCustomerId, nonce, deviceData)` — Braintree `paymentMethod.create` with `verifyCard + makeDefault`.
3. `savePaymentMethod({ ..., makeDefault })` — upsert into `customer_payment_methods`; demotes other defaults in the customer's link group when `makeDefault=true`.
4. If `migrate !== false`: `migrateCustomerAppstleSubsToInternal(workspaceId, customerId, { isRecovery })` — sweeps the customer's Appstle subs to internal billing.

**Failure behavior:**
- Vault failure → throws. Callers decide: portal returns 502; the journey returns 502 AND keeps the session `in_progress` (fail closed — no completion signal, client shows retry).
- Migration failure → logged but NOT re-thrown; the vault succeeded and we don't want to lose the card because one sub couldn't migrate. Matches the portal handler's original behavior.

## Callers

- `src/lib/portal/handlers/payment-method-update.ts` — portal "add a card" + `recover` (failed-payment magic-link) + sub-scoped add.
- `src/app/api/journey/[token]/submit-payment/route.ts` — the `add_payment_method` mini-site journey's submit path.

## Related

- [[portal__handlers__payment-methods]] — the portal handler; recovery / pin-to-sub / Slack notify wrap the shared sequence.
- [[add-payment-method-journey-builder]] — the mini-site journey; its submit endpoint calls this helper.
- [[migrate-to-internal]] — `migrateCustomerAppstleSubsToInternal` details.
- [[../integrations/braintree]] — vault, save, client token.

## Gotchas

- The BT customer resolution intentionally mirrors the portal handler's original two-step lookup (existing PM row → `resolveBraintreeCustomerId`). A raw `resolveBraintreeCustomerId` on every call would create phantom customers when we already have one on file for this shopcx customer.
- Callers pass `makeDefault=false` + `migrate=false` for the sub-scoped portal add-card flow (pin the new card to one sub, don't touch defaults or the book). The journey always passes true/true — a customer with no vaulted card is exactly the migrate-the-book case.

---

[[../README]] · [[../../CLAUDE]]
