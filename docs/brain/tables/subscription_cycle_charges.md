# subscription_cycle_charges

**Per-(subscription, billing cycle) idempotency ledger** guarding the internal-subscription renewal charge chokepoint. One row per (subscription_id, cycle_key). The **unique index on (subscription_id, cycle_key)** is the actual guarantee: two concurrent immediate-charge triggers for the same sub's current cycle race on the INSERT and exactly one wins — the loser becomes a benign `refused_duplicate_cycle` skip instead of a second Braintree sale.

**Phase 1 of** [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]] (parent: retention "Subscription continuity & billing integrity" mandate). Written by [[../inngest/internal-subscription-renewals]]'s `internal-subscription-renewal-attempt` handler via [[../libraries/subscription-cycle-charge-claim]] — never a raw `.from(...)` (per CLAUDE.md).

**Ground truth:** on 2026-08-28 internal sub fd857ad9 (`internal-a02696e2129c42a8`) produced SHOPCX273 (17:18:44) and SHOPCX274 (17:22:56) — both $102.33, both 2x Salted Caramel, both `source_name='internal_subscription_renewal'`, both `type='renewal'` `status='succeeded'` with SEPARATE Braintree transactions (`978p0vtf`, `3cv2w8t8`). No double-click. The existing `isRenewalAttemptStale` guard exempts immediate-charge callers (portal order-now, payment-method recovery, appstle `orderNowByContract`) because they send NO `expected_next_billing_date` — so nothing dedupes them. This ledger closes that gap for BOTH the scheduled and the immediate paths.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | tenant-scoped audit / cleanup key. Not FK'd (deliberate — this row survives a workspace lifecycle event and stays a durable billing record) |
| `subscription_id` | `uuid` | — | the sub being charged. Not FK'd — same rationale (a subscription-delete does not erase the audit) |
| `cycle_key` | `text` | — | derived from the sub's **pre-charge** `next_billing_date`, truncated to `YYYY-MM-DD` via `cycleKeyFromNextBillingDate` in [[../libraries/subscription-cycle-charge-claim]]. Pins concurrent triggers reading the same live date to the SAME key regardless of the hh:mm:ss the handler stamps. `unknown-cycle` when the input date is unusable — the SDK caller MUST short-circuit rather than claim under a garbage key |
| `status` | `text` | — | default `'in_flight'` · CHECK `IN ('in_flight','succeeded','failed')` |
| `amount_cents` | `integer` | ✓ | the total the caller intended to charge — helps the Phase 2 duplicate-renewal detector shape the "same amount" query |
| `claimant` | `text` | — | the Inngest `event.id` (or a synthetic `sub:<id>:cycle:<key>` when the event has none). Same claimant hitting the same key on a step re-run = a resumed claim (not a duplicate) — [[../libraries/subscription-cycle-charge-claim]] `claimCycleCharge` returns `{ ok: true, resumed: true }` |
| `source` | `text` | ✓ | which caller / reason (e.g. `internal_subscription_renewal`) — audit + future taxonomy |
| `transaction_id` | `uuid` | ✓ | back-link to the [[transactions]] row the charge produced (null on `in_flight` and often on `failed` if the Braintree sale never seated a transaction row) |
| `order_id` | `uuid` | ✓ | back-link to the [[orders]] row on `succeeded` (null on `in_flight` / `failed`) |
| `claimed_at` | `timestamptz` | — | default `now()` |
| `resolved_at` | `timestamptz` | ✓ | stamped by `resolveCycleCharge` when the row moves out of `in_flight` |

**Indexes:**
- **UNIQUE `(subscription_id, cycle_key)`** — the guard. Two concurrent inserts race and exactly one wins. Same class as the [[ticket_directions]] partial-UNIQUE one-live-row invariant.
- `(subscription_id, claimed_at DESC)` — the per-sub recent-claims read.
- `(workspace_id, claimed_at DESC)` — per-workspace audits / cleanup.

## Claim lifecycle

1. **INSERT `in_flight`** — [[../inngest/internal-subscription-renewals]] runs `claim-cycle-charge` after all skip gates pass but BEFORE `insert-pending-transaction` (so a refused duplicate never leaves an orphan pending `transactions` row). On unique-violation (`23505`), the SDK reads the existing row: same `claimant` → resumed (proceed); different `claimant` → refuse the second trigger.
2. **UPDATE → `succeeded`** — after the `orders` row lands, `resolve-cycle-claim-succeeded` stamps status + `transaction_id` + `order_id` + `resolved_at`. A subsequent immediate-charge trigger for the same `(subscription_id, cycle_key)` is refused — no SHOPCX274-shaped duplicate.
3. **UPDATE → `failed`** — on Braintree decline, `resolve-cycle-claim-failed` stamps status + `transaction_id` + `resolved_at`. Dunning's `resetBillingDateAfterDunning` moves `next_billing_date` forward on decline, so its retry naturally lands on a NEW `cycle_key` and does NOT collide with the failed row.

The UPDATE branches are compare-and-set on `status='in_flight'` so a stale duplicate cannot overwrite a real outcome.

## Foreign keys

**Out:** none (workspace_id / subscription_id are deliberately not FK'd — the audit outlives the row).

**In:** none.

## Read paths

- [[../libraries/subscription-cycle-charge-claim]] `claimCycleCharge` (the SDK write path) and `readCycleCharge` (the 23505-branch lookup + diagnostic helper) are the only readers today.
- Phase 2 of the parent spec will add a **duplicate-renewal detector** that scans this ledger for `succeeded` rows on the same `subscription_id` within a short window; the ledger's uniqueness on `cycle_key` is the primary block, and the detector is the safety-net observer for any pattern the ledger doesn't already refuse.

## RLS

`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` with NO policies — service-role only, per CLAUDE.md. Every write goes through `createAdminClient()` in [[../inngest/internal-subscription-renewals]] via the [[../libraries/subscription-cycle-charge-claim]] SDK.

---

[[../README]] · [[../inngest/internal-subscription-renewals]] · [[../libraries/subscription-cycle-charge-claim]] · [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]] · [[../../CLAUDE]]
