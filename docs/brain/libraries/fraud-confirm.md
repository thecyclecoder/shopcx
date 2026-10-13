# libraries/fraud-confirm

The one-customer-at-a-time fraud-confirmation contract — pure helpers shared by the confirm-fraud route and the fraud-status readers so the "confirm acts on exactly one customer" invariant lives in one place.

**File:** `src/lib/fraud-confirm.ts`

## Why

Spec `fraud-bin-velocity-requires-real-cross-account-link` Phase 3. A case-wide confirm turned one real fraudster into 8 innocent subscribers refunded, cancelled and banned in a single click (bin:414740, Sep 2026). Confirming fraud must act on exactly one named customer; a grouping mistake must never become mass damage.

## Exports

### `validateConfirmCustomerId(body, caseCustomerIds)` — function

```ts
function validateConfirmCustomerId(body: Record<string, unknown>, caseCustomerIds: string[]): ConfirmCustomerValidation
```

Every confirm-fraud step requires a single `body.customer_id` that is a member of the case's `customer_ids`. Returns `{ ok: true, customerId }` or `{ ok: false, status: 400, error }`. Rejects the legacy case-wide shapes: a `customer_ids` (plural) body, a missing/empty id, a non-string (e.g. array) id, or a customer outside the case.

### `appendConfirmedCustomerId(prior, customerId)` — function

Dedupe-append a confirmed customer to a case's `confirmed_customer_ids`. Used by the `complete` step (and the chargeback-loss + reseller-ban automated paths) so confirming the same customer twice is idempotent and confirming a second customer never drops the first.

### `isCustomerConfirmedFraud(confirmedCustomerIds, linkedCustomerIds)` — function

The reader predicate: a `status='confirmed_fraud'` case counts as confirmed fraud for a customer ONLY when the case's `confirmed_customer_ids` overlaps the customer's linked ids. A customer who merely shares a case (e.g. a shared bank BIN) with a confirmed fraudster is NOT confirmed fraud.

### `filterToCustomer(rows, customerId)` — function

Per-step scoping predicate — keep only the rows belonging to the one customer being confirmed. Mirrors the `.eq("customer_id", customerId)` filter the route applies to subscriptions and orders.

## Callers

- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts` — `validateConfirmCustomerId` (guard on every step) + `appendConfirmedCustomerId` (complete step).
- [[customer-fraud-status]] `getCustomerFraudStatus`, `src/lib/commerce/fraud.ts` `getFraudPosture`, `src/lib/sonnet-orchestrator-v2.ts` `getFraudCases`, and the repeat-offender similarity check in [[fraud-detector]] — the `isCustomerConfirmedFraud` reader predicate.
- [[../inngest/chargeback-processing]] + `scripts/cancel-and-ban-resellers.ts` — `appendConfirmedCustomerId` (automated confirmation paths).

## Tests

`src/lib/fraud-confirm-single-customer.test.ts` (registered as `test:fraud-confirm-single-customer`) — validator 400s, per-customer scoping (only A's subs/orders), dedupe-append, and the reader predicate (B, not individually confirmed, is not blocked).

See [[../tables/fraud_cases]] `confirmed_customer_ids` and [[../lifecycles/fraud-detection]] Phase 7.

---

[[../README]] · [[../../CLAUDE]]
