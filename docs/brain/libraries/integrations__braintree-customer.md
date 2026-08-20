# libraries/integrations/braintree-customer

Braintree customer create / find helpers.

**File:** `src/lib/integrations/braintree-customer.ts`

## File header

```
Resolve (or create) the Braintree customer for a given shopcx
customer. Three-tier lookup so we never duplicate Braintree records:
1. Local DB  — customers.braintree_customer_id, if we've seen them before.
2. Braintree — search Braintree by email. Handles cases where a BT
customer exists from a prior code path / manual entry
/ a different shopcx workspace that already touched
this merchant.
3. Create    — new BT customer, stamp the id back onto our customers row.
Returns the resolved Braintree customer id. Throws if Braintree
isn't configured for the workspace.
Email is the dedup key. We don't try to dedup by phone — phone is
common across household members and we'd merge separate people.
```

## Exports

### `resolveBraintreeCustomerId` — function

```ts
async function resolveBraintreeCustomerId(input: ResolveInput,) : Promise<string>
```

### `savePaymentMethod` — function

```ts
async function savePaymentMethod(input: PaymentMethodSaveInput) : Promise<
```

### `vaultPaymentMethod` — function

```ts
async function vaultPaymentMethod(workspaceId: string, braintreeCustomerId: string, paymentMethodNonce: string, deviceData?: string,) : Promise<VaultResult>
```

Throws [[#VaultCreateError]] on `paymentMethod.create` failure — the code is derived from the SDK's `verification.status` so callers can distinguish a customer-fixable decline from a genuine gateway/config outage without parsing raw processor text.

### `VaultCreateError` — class

Typed error thrown by `vaultPaymentMethod` when Braintree refuses the vault. Carries a stable `code`:

| `code` | Trigger (`verification.status`) | Meaning |
|---|---|---|
| `vault_declined` | `processor_declined` OR `gateway_rejected` | Customer's own issuer said no, OR merchant's Braintree risk rule said no. Nothing to fix on our side — customer needs to try another card or correct number/CVV/expiry. |
| `vault_error` | anything else (SDK broken, connectivity, misconfig, unrecognized shape) | Genuine gateway/config problem — real Braintree outage territory. |

The `message` field carries the RAW upstream text (`processorResponseText`, `Gateway Rejected: <reason>`, or SDK error) — safe for a server log line and preserved so [[control-tower/error-feed]]'s existing marker-based decline / rejection drop filters keep matching. Callers must NOT surface this message directly to the customer (it can include instrument-specific processor surface text); each caller composes its own plain-language customer message. See [[portal__handlers__payment-methods]] for how the portal maps `vault_declined` to `"That card was declined. Please check the number, expiry, and CVV, or try another card."` and [[portal__remediation]] for the dismiss disposition.

### `PaymentMethodSaveInput` — interface

### `VaultResult` — interface

## Callers

- `src/app/api/checkout/client-token/route.ts`
- `src/app/api/checkout/route.ts`
- `src/lib/vault-and-migrate-payment-method.ts` — the portal + add-payment-method-journey chokepoint that re-throws `VaultCreateError` to its callers.

## Gotchas

- **A vault failure is one of two very different things** — a customer-fixable decline (issuer said no, or Braintree risk rule said no) OR a genuine gateway/config outage. Before the [[../specs/classify-portal-vault-failed-card-declines-instead-of-escalating]] spec, both threw a generic `Error(msg)` and the portal returned `502 { error: "vault_failed" }` for either — the actionable decline reason was discarded and every decline mis-escalated to the CS Director. The typed `VaultCreateError` + `code` split is the fix: [[portal__handlers__payment-methods]] returns `400 { error: "vault_declined", message: "…" }` for a decline (customer-fixable soft error) and keeps `502 { error: "vault_failed" }` for a genuine gateway/config `vault_error`. [[portal__route]]'s `VALIDATION_ERRORS` set (which now includes `vault_declined`) stops a decline from spawning a ticket at all, and [[portal__remediation]]'s dismiss branch is the belt-and-suspenders backstop.

---

[[../README]] · [[../../CLAUDE]]
