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

### Reclaimable rows: `failed` OR stale `in_flight`

A prior claim is **reclaimable** — a new claimant is allowed to atomically take the row over — when no money-moving action can still be in progress against it. Two cases hit that bar:

- **`status='failed'`** — Braintree already declined, so no sale seated. The row would otherwise wedge every subsequent attempt against the same cycle_key.
- **`status='in_flight'` older than `STALE_IN_FLIGHT_RECLAIM_MS` (10 min)** — a crashed prior claim is indistinguishable from a `failed` one at the wedge level; a Braintree sale + surrounding Inngest step normally settles in seconds, so a still-`in_flight` row past ten minutes is a stranded attempt. The constant is exported so the number is reviewable rather than buried; widen it if a legitimate caller ever holds a claim longer. Phase 1 of [[../specs/a-declined-renewal-must-not-wedge-the-cycle-forever]].

Both branches take the row over rather than inserting a second one (the unique index on `(subscription_id, cycle_key)` means there is only ever one row): reset to `status='in_flight'`, stamp the new `claimant` + fresh `claimed_at`, clear `resolved_at`/`transaction_id`/`order_id`, and **prepend** a snapshot of the prior claim to `superseded_claims` so a repeatedly-declining sub stays visible as such rather than silently overwritten. The UPDATE is compare-and-set on the prior row's exact `status` AND `claimed_at` so a concurrent thread that already reset the row (or a fresh in-flight attempt that just re-stamped `claimed_at`) blocks the reset — the caller falls through to the normal refusal via a re-read.

Fresh `in_flight` and `succeeded` rows still refuse a new claimant. This is the fix for the wedge case in [[../archive.d/failed-cycle-charge-claim-must-not-wedge-order-now-and-renewal-retries]] (ticket `cce7d76b`) generalized past the failed-only shape: dunning's `resetBillingDateAfterDunning` re-anchors `next_billing_date` onto the same date whose prior claim is still on the ledger, so every subsequent portal order-now derives the same cycle_key and hits the same row — reclaiming `failed` cleared the decline case; reclaiming a stale `in_flight` clears the crashed-attempt case that would otherwise wedge exactly the same way.

## Exports

- `type CycleChargeStatus = 'in_flight' | 'succeeded' | 'failed'` — mirrors the CHECK on the column.
- `interface CycleChargeRow` — the shape returned by `readCycleCharge` / the `existing` branch of `claimCycleCharge` (now includes `superseded_claims: SupersededClaim[]`).
- `interface SupersededClaim` — one snapshot appended to `superseded_claims` when a prior claim on the same row is reclaimed. Fields: `{ claimant, status, source, transaction_id, order_id, claimed_at, resolved_at, superseded_at, superseded_reason: 'failed' | 'stale_in_flight' }`.
- `interface ClaimInput { workspace_id; subscription_id; cycle_key; claimant; amount_cents?; source? }`.
- `type ClaimResult` — discriminated union:
  - `{ ok: true; id; resumed: false }` — fresh insert OR atomic reset of a prior reclaimable row (see "Reclaimable rows" above).
  - `{ ok: true; id; resumed: true; existing }` — same `claimant` already holds the key (a resumed Inngest step run).
  - `{ ok: false; existing }` — a DIFFERENT `claimant` holds the key AND its status is fresh `in_flight` or `succeeded`. Caller MUST refuse the charge.
- `const STALE_IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000` — the "no charge can take this long" threshold. Any `in_flight` row older than this is treated as a crashed prior attempt and reclaimable.
- `cycleKeyFromNextBillingDate(nextBillingDate: string | null | undefined): string` — pure. `YYYY-MM-DD` derived from the sub's pre-charge `next_billing_date`. Falls back to `'unknown-cycle'` on a garbage / missing input (the caller MUST short-circuit those rather than claim under a colliding key).
- `isReclaimable(existing, now?): { reason: 'failed' | 'stale_in_flight' } | null` — pure predicate factored out of `claimCycleCharge`. Pinned by `src/lib/subscription-cycle-charge-claim.test.ts` so the "status-aware refusal" invariant is not silently regressed.
- `renewalRefusalOutcomeLabel(existingStatus): 'skipped_other' | 'refused_wedged_cycle'` — pure. Phase 2 of [[../specs/a-declined-renewal-must-not-wedge-the-cycle-forever]]. Maps a refusal's existing-claim status to the outcome-heartbeat label: `succeeded` → `skipped_other` (benign — the real charge already resolved this cycle), anything else → `refused_wedged_cycle` (a customer cannot be billed for THIS cycle, alertable via `RENEWAL_BAD_OUTCOMES`). Called by [[../inngest/internal-subscription-renewals]] at the refusal step-emit.
- `claimCycleCharge(admin, input): Promise<ClaimResult>` — INSERTs `status='in_flight'`. On unique-violation (`23505`), looks up the existing row: same-claimant → resumed; different-claimant on a reclaimable row (`failed` OR stale `in_flight`) → compare-and-set reset back to `in_flight` under the new claimant (prepending a superseded-snapshot); different-claimant on fresh `in_flight`/`succeeded` → refusal. Every other DB error propagates (a service failure while claiming is NOT silently treated as "safe to charge").
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
