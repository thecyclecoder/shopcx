# libraries/subscription-cycle-charge-claim

**File:** `src/lib/subscription-cycle-charge-claim.ts`

SDK for the per-(subscription, billing cycle) idempotency ledger backing [[../tables/subscription_cycle_charges]]. Every write to that table goes through this SDK — never a raw `.from(...)` (per CLAUDE.md "Raw `.from(...)` with no SDK → STOP").

Called from [[../inngest/internal-subscription-renewals]]'s `internal-subscription-renewal-attempt` handler — the chokepoint every internal immediate-charge caller funnels through (portal order-now, payment-method recovery, appstle `orderNowByContract`, scheduled cron). Implements Phase 1 & Phase 2 of [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]]; Phase 1 & 2 of [[../specs/a-declined-renewal-must-not-wedge-the-cycle-forever]]; and the cycle-key + per-subscription guard from [[../specs/a-renewal-cycle-key-must-not-derive-from-a-field-the-charge-moves]].

## Phase 1 — Pin the key to the dispatched cycle, not live state

**Ground truth:** sub e9b8a6d9 claimed cycle_key `2026-10-30` at 15:30:46.79 ($108.01) and `2026-12-25` at 15:30:55.20 ($140.28), both succeeded, eight seconds apart, both `source_name=internal_subscription_renewal`. A successful renewal advances `subscriptions.next_billing_date`, so two concurrent attempts that re-derive the key from that live field compute DIFFERENT keys for what is really the SAME cycle. Both attempts claimed cleanly and both charged.

**The fix:** cycle_key is now derived from the **dispatched** cycle (`expected_next_billing_date` stamped onto the attempt event by the dispatcher), NOT a live re-read of the sub's `next_billing_date`. Two concurrent renewals for the same reactivation now pin to the SAME cycle_key and the unique index refuses the second.

- `cycleKeyFromDispatchedNextBillingDate(nextBillingDate: string | null | undefined): string | null` — pure, returns YYYY-MM-DD slice or `null` if the dispatched value is missing/unparseable. The caller MUST refuse rather than falling back to a live read — that fallback is the hole this helper closes.
- Every dispatcher that fires `internal-subscription/renewal-attempt` now stamps the pre-charge cycle onto the event: cron fan-out (`expected_next_billing_date`), portal order-now (`src/lib/portal/handlers/order-now.ts`), payment-method recovery (`src/lib/portal/handlers/payment-method-update.ts`), and `subscriptionOrderNow` (`src/lib/commerce/subscription.ts`).
- When the cycle arrives and the key is successfully derived, the claim proceeds normally.
- When the cycle is missing or unparseable, the handler refuses the charge with outcome `refused_wedged_cycle` and logs customer event `subscription.renewal_refused_missing_dispatched_cycle` — closing the "must have a valid cycle" hole.

## Phase 2 — One renewal in flight per subscription

The Phase 1 fix stops the equal-cycle case, but the class survives — a variant of overlapping renewals can find a different way to disagree about which cycle it is charging. A per-SUBSCRIPTION gate refuses a second attempt while one is already in flight for that sub, **regardless of what key it computes**.

- `pickBlockingInFlightForSubscription(rows: readonly InFlightRowSummary[], claimant: string): InFlightRowSummary | null` — pure predicate. Given every in_flight row for a subscription, returns the first one claimed by a DIFFERENT claimant, or `null` if only the caller's rows exist. A resumed Inngest step re-check never refuses itself.
- `findBlockingInFlightForSubscription(admin, subscriptionId, claimant): Promise<InFlightRowSummary | null>` — queries all `status='in_flight'` rows for the subscription and applies the pure predicate.
- Wired into [[../inngest/internal-subscription-renewals]] as step 2.6 'check-subscription-in-flight', running BEFORE the cycle-key claim. A second attempt is refused regardless of what key it computes.
- Refusal is **DISTINCT** from the cycle-key refusal: outcome `refused_concurrent_renewal` (in RENEWAL_BAD_OUTCOMES so it alerts) and customer event `subscription.renewal_refused_concurrent_attempt` — so 'two attempts raced' and 'this cycle was already charged' don't look identical in the timeline.
- **Refuses rather than queues.** A renewal that waits and then fires is still a second charge; the customer only authorised one.
- Eight seconds apart (the ground-truth case) is well inside any plausible charge duration, so this gate alone would have stopped the double-charge even with the old key.

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

### Reclaimable rows: `failed` only

A prior claim is **reclaimable** — a new claimant is allowed to atomically take the row over — only when no Braintree sale ever settled for it. Exactly one status hits that bar:

- **`status='failed'`** — Braintree already declined, so no sale seated. The row would otherwise wedge every subsequent attempt against the same cycle_key.

Every other status refuses:

- **`succeeded`** — the money already moved; a second sale would be a duplicate charge.
- **fresh `in_flight`** — a concurrent attempt may still land.
- **stranded `in_flight`** (older than `STALE_IN_FLIGHT_RECLAIM_MS` = 10 min) — the prior attempt crashed AFTER Braintree settled the sale but BEFORE `resolveCycleCharge` fired is a real (and untestable-from-the-DB-alone) possibility. Auto-reclaiming would run a SECOND Braintree sale for the same cycle. Fix 1 of [[../specs/a-declined-renewal-must-not-wedge-the-cycle-forever]] closed this after the pre-merge spec-test flagged it as a high-severity billing-idempotency regression. A stranded `in_flight` surfaces as WEDGED through the [[../inngest/internal-subscription-renewals]] Control Tower **renewal-wedged-cycles** assertion; the remediation is an explicit reconciliation/repair path that reads Braintree and proves no external charge settled before any retry — this SDK does NOT do that itself.

The reclaim (only case: `failed`) takes the row over rather than inserting a second one (the unique index on `(subscription_id, cycle_key)` means there is only ever one row): reset to `status='in_flight'`, stamp the new `claimant` + fresh `claimed_at`, clear `resolved_at`/`transaction_id`/`order_id`, and **prepend** a snapshot of the prior claim to `superseded_claims` so a repeatedly-declining sub stays visible as such rather than silently overwritten. The UPDATE is compare-and-set on the prior row's exact `status='failed'` AND `claimed_at` so a concurrent thread that already reset the row (or a concurrent outcome that landed between SELECT and UPDATE) blocks the reset — the caller falls through to the normal refusal via a re-read.

This is the fix for the wedge case in [[../archive.d/failed-cycle-charge-claim-must-not-wedge-order-now-and-renewal-retries]] (ticket `cce7d76b`): dunning's `resetBillingDateAfterDunning` re-anchors `next_billing_date` onto the same date whose failed claim is still on the ledger, so every subsequent portal order-now derives the same cycle_key and hits the same row — reclaiming clears the decline case without opening the double-charge door on a stranded `in_flight`.

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
- `cycleKeyFromNextBillingDate(nextBillingDate: string | null | undefined): string` — pure. `YYYY-MM-DD` derived from the sub's pre-charge `next_billing_date`. Falls back to `'unknown-cycle'` on a garbage / missing input (the caller MUST short-circuit those rather than claim under a colliding key). ⚠️ **Deprecated for internal-renewal use:** prefer `cycleKeyFromDispatchedNextBillingDate` — the key must come from the ATTEMPT event, not a live sub read.
- `cycleKeyFromDispatchedNextBillingDate(dispatchedNextBillingDate: string | null | undefined): string | null` — pure. `YYYY-MM-DD` derived from the **dispatched** cycle carried by the attempt event (`expected_next_billing_date`), NOT a live re-read. Returns `null` when missing/unparseable. The caller MUST refuse rather than falling back to a live read. See Phase 1 above.
- `chargeIdempotencyKeyFromDispatchedNextBillingDate` — alias for `cycleKeyFromDispatchedNextBillingDate`.
- `isReclaimable(existing, now?): { reason: 'failed' } | null` — pure predicate factored out of `claimCycleCharge`. Returns `{ reason: 'failed' }` only for a `status='failed'` row; every other status (including a stranded `in_flight` past `STALE_IN_FLIGHT_RECLAIM_MS`) returns `null` and refuses. Pinned by `src/lib/subscription-cycle-charge-claim.test.ts` so the "status-aware refusal" invariant — and the deliberate refusal of stale in_flight — is not silently regressed.
- `renewalRefusalOutcomeLabel(existingStatus): 'skipped_other' | 'refused_wedged_cycle'` — pure. Phase 2 of [[../specs/a-declined-renewal-must-not-wedge-the-cycle-forever]]. Maps a refusal's existing-claim status to the outcome-heartbeat label: `succeeded` → `skipped_other` (benign — the real charge already resolved this cycle), anything else → `refused_wedged_cycle` (a customer cannot be billed for THIS cycle, alertable via `RENEWAL_BAD_OUTCOMES`). Called by [[../inngest/internal-subscription-renewals]] at the refusal step-emit.
- `type InFlightRowSummary = Pick<CycleChargeRow, "id" | "claimant" | "status" | "cycle_key" | "claimed_at">` — minimal shape for the Phase 2 in-flight gate predicate.
- `pickBlockingInFlightForSubscription(rows: readonly InFlightRowSummary[], claimant: string): InFlightRowSummary | null` — pure. Returns the first in_flight row claimed by a DIFFERENT claimant, or `null` if only the caller's rows exist. A resumed step never blocks itself. See Phase 2 above.
- `findBlockingInFlightForSubscription(admin, subscriptionId, claimant): Promise<InFlightRowSummary | null>` — queries all `status='in_flight'` subscription_cycle_charges rows and applies the pure predicate. Called by [[../inngest/internal-subscription-renewals]] `check-subscription-in-flight` step.
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
