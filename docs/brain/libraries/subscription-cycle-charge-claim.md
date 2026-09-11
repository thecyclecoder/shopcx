# libraries/subscription-cycle-charge-claim

**File:** `src/lib/subscription-cycle-charge-claim.ts`

SDK for the per-(subscription, billing cycle) idempotency ledger backing [[../tables/subscription_cycle_charges]]. Every write to that table goes through this SDK — never a raw `.from(...)` (per CLAUDE.md "Raw `.from(...)` with no SDK → STOP").

**Phase 1 of** [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]]. Called from [[../inngest/internal-subscription-renewals]]'s `internal-subscription-renewal-attempt` handler — the chokepoint every internal immediate-charge caller funnels through (portal order-now, payment-method recovery, appstle `orderNowByContract`, scheduled cron).

## The move

The unique index on `(subscription_id, cycle_key)` is the actual guard — this SDK just converts the constraint into a typed refusal instead of an exception. The handler's flow becomes:

```
1. cycleKeyFromNextBillingDate(sub.next_billing_date)  // pure — YYYY-MM-DD
2. claimCycleCharge(admin, { … })                       // INSERT status='in_flight'
   ├─ ok:true  resumed:false → fresh claim, proceed to charge
   │                            (fresh insert OR the atomic reset of a prior `status='failed'`
   │                             row — see "Failed rows are re-claimable" below)
   ├─ ok:true  resumed:true  → same-run Inngest step retry, proceed
   └─ ok:false               → another claimant holds the key AND its status is `in_flight`
                                 or `succeeded`, REFUSE
3. Braintree sale + orders/transactions rows
4. resolveCycleCharge(admin, id, { status: 'succeeded' | 'failed', … })
```

The `claimant` field carries the Inngest `event.id` so a step re-run after a partial post-INSERT failure recognizes its own row instead of double-refusing itself. A DIFFERENT claimant with an `in_flight` or `succeeded` existing row is the actual double-charge case — refused.

### Failed rows are re-claimable

A prior claim with `status='failed'` means **no Braintree sale occurred for that cycle** — the row must NOT be a permanent block. On a 23505 conflict where the existing row is `failed`, `claimCycleCharge` atomically resets+re-owns it (`status='in_flight'`, new `claimant`, `resolved_at=null`, `transaction_id=null`, `order_id=null`) and returns `{ ok: true, resumed: false }`. The UPDATE is compare-and-set on `status='failed'` so a concurrent thread that already reset it does NOT get double-reset, and any concurrent `succeeded`/`in_flight` outcome that landed between the SELECT and the UPDATE stops the reset (the caller falls through to the normal refusal).

This is the fix for the wedge case in [[../specs/failed-cycle-charge-claim-must-not-wedge-order-now-and-renewal-retries]] (ticket `cce7d76b`): dunning's `resetBillingDateAfterDunning` re-anchored `next_billing_date` onto the SAME date whose failed claim was still on the ledger, so every subsequent portal order-now (fresh claimant deriving the same cycle_key) collided on the failed row and surfaced `renewal_refused_duplicate_cycle` — the sub was permanently wedged and the next scheduled renewal would have failed the same way. The reset makes the ledger self-healing for the no-money-moved outcome without weakening the against-double-charge guarantee for `succeeded` / `in_flight`.

## Exports

- `type CycleChargeStatus = 'in_flight' | 'succeeded' | 'failed'` — mirrors the CHECK on the column.
- `interface CycleChargeRow` — the shape returned by `readCycleCharge` / the `existing` branch of `claimCycleCharge`.
- `interface ClaimInput { workspace_id; subscription_id; cycle_key; claimant; amount_cents?; source? }`.
- `type ClaimResult` — discriminated union:
  - `{ ok: true; id; resumed: false }` — fresh insert OR atomic reset of a prior `status='failed'` row (see "Failed rows are re-claimable" above).
  - `{ ok: true; id; resumed: true; existing }` — same `claimant` already holds the key (a resumed Inngest step run).
  - `{ ok: false; existing }` — a DIFFERENT `claimant` holds the key AND its status is `in_flight` or `succeeded`. Caller MUST refuse the charge.
- `cycleKeyFromNextBillingDate(nextBillingDate: string | null | undefined): string` — pure. `YYYY-MM-DD` derived from the sub's pre-charge `next_billing_date`. Falls back to `'unknown-cycle'` on a garbage / missing input (the caller MUST short-circuit those rather than claim under a colliding key).
- `claimCycleCharge(admin, input): Promise<ClaimResult>` — INSERTs `status='in_flight'`. On unique-violation (`23505`), looks up the existing row: same-claimant → resumed; different-claimant on a `failed` row → compare-and-set reset back to `in_flight` under the new claimant (fresh claim); different-claimant on `in_flight`/`succeeded` → refusal. Every other DB error propagates (a service failure while claiming is NOT silently treated as "safe to charge").
- `readCycleCharge(admin, subscription_id, cycle_key): Promise<CycleChargeRow | null>` — the read-only lookup used inside `claimCycleCharge`'s 23505 branch and exposed for diagnostics.
- `resolveCycleCharge(admin, id, { status, transaction_id?, order_id?, amount_cents? }): Promise<{ updated: boolean }>` — compare-and-set on `status='in_flight'` so a stale duplicate cannot overwrite a real outcome. `updated=false` means the row was already resolved by a concurrent step (safe; skip the second stamp).

## Called by

- [[../inngest/internal-subscription-renewals]] `internal-subscription-renewal-attempt` — `claim-cycle-charge` step (post skip-gates, pre pending-transaction), `resolve-cycle-claim-succeeded` step (after the `orders` row lands), `resolve-cycle-claim-failed` step (after Braintree decline).

## Callers of the guard downstream

Every path that fires the `internal-subscription/renewal-attempt` event is covered by the handler's guard automatically. No caller needs its own claim:

- Scheduled cron — `internal-subscription-renewal-cron` fan-out.
- Portal — `src/lib/portal/handlers/order-now.ts` (internal branch).
- Portal — `src/lib/portal/handlers/payment-method-update.ts` (recovery charge on migrated internal subs).
- `src/lib/appstle.ts` `orderNowByContract` (internal branch).
- `src/lib/vault-and-migrate-payment-method.ts` (order-now retry on migrated internal subs).

The Appstle-side `appstleAttemptBilling` for non-internal subs is Appstle's own responsibility (its API already refuses concurrent billing with `"Another billing operation is already in progress"` — treated as a benign race).

## Invariants

- **UNIQUE `(subscription_id, cycle_key)`** — the DB constraint IS the guard. The SDK cannot bypass it; a bug that stopped calling `claimCycleCharge` would still fail on the second INSERT because the unique index refuses it.
- **Compare-and-set on resolve** — `resolveCycleCharge` matches on `status='in_flight'`, so a duplicate that raced through cannot silently retag a real outcome.
- **RLS enabled, deny-all** — the table has no policies; the service-role client is the only writer.

---

[[../README]] · [[../tables/subscription_cycle_charges]] · [[../inngest/internal-subscription-renewals]] · [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]] · [[../../CLAUDE]]
