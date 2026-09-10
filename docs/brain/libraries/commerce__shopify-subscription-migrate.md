# `src/lib/commerce/shopify-subscription-migrate.ts`

Plans and executes the Appstle→ShopCX migration, one contract at a time.

Snapshot source: [[../tables/appstle_contract_snapshots]] · client:
[[commerce__shopify-subscription-client]] · renewal: [[../inngest/shopify-subscription-renewals]]

## The pricing model (CEO, 2026-09-10)

Appstle bakes the customer's rate into the line with no selling plan and no discount policy, which
is why nobody can tell *why* a given customer pays what they pay. Migrated contracts invert that —
the line is MSRP and every reduction is an explicit, named discount:

```
line        = catalog MSRP
− S&S 25%
− quantity break   8% @2, 12% @3+   MIX-AND-MATCH across lines sharing the rule
− grandfather      per-unit FIXED, scoped to ONE line
```

**Grandfathering is per-line and per-unit, never order-level.** Contract 27801911469 needs −$3.20 on
one line and −$2.80 on another; an order-level discount physically cannot express that, and a rate
negotiated on one product must not leak onto the rest of the contract.

## ⭐ Shopify's discount arithmetic — measured, not assumed

`shopifyLineMath()` reproduces it exactly. Discounts stack **multiplicatively and sequentially**,
each allocation computed on the running remainder of the **line total** and **TRUNCATED** to cents:

```
base $79.95 ×1
  S&S 25%    → $19.98   (19.9875 truncated, NOT rounded to 19.99)
  Volume 12% → $7.19    (on the remainder: 59.97 × 0.12 = 7.1964 truncated)
  = $52.78
```

Measured on the first multi-discount migration (35945218221). An additive model predicted $50.37.

This is not pedantry: the grandfather lock is `standard − current`, so a cent of drift in `standard`
is a cent of drift in the price we promised to preserve **exactly**. Correcting the arithmetic moved
grandfather locks 922 → 1,916, because truncation yields slightly less discount so more customers
sit below standard and get preserved rather than nudged.

## Line rules

| rule | why |
|---|---|
| resolve by **SKU**, fall back to `variant_id` | variant ids drift across relists — **338 lines** point at a retired variant. 0 unresolvable across 2,477. |
| ACV gummies dropped | CEO decision |
| `$0` line dropped | a $0 consumable is invalid on a live sub; all such lines had already shipped and were stale |
| protection: own price, no S&S, no break, excluded from mix qty, qty≤1 | it is a passthrough digital add-on, not a consumable |
| structural discounts **recomputed**, never copied | copying a stored tier is exactly how 386 contracts froze at the wrong quantity break |
| **shipping charge CARRIED, not zeroed** | the rule's free shipping governs NEW subs; 1,620 active contracts pay $4.95 from a period when free shipping wasn't offered on all subs. A legacy shipping term is a term of the subscription exactly like a legacy unit price — zeroing it is an unrequested ~$8,019/cycle giveaway and inconsistent with the 1,916 grandfather locks. |
| customer codes carried only if `recurringCycleLimit`/`usageCount` allow | `usageCount` **resets to 0 on a new contract**, so a consumed one-use code would be re-granted |

## Ordering — every partial failure leaves the customer billed by SOMEONE

```
fresh read → drift check → atomic create (discounts ride along) → VERIFY pricing
   → point our row at the new contract + billing_source='shopcx'   (we bill it)
   → cancel Appstle                                                (they stop)
```

The local flip happens **before** the Appstle cancel, deliberately. Cancel-first then a failed flip
leaves the sub billed by **nobody** — silent revenue loss, the failure this whole design exists to
prevent. This way a failure between the two leaves both engines owning it for a few seconds, which
is survivable: Shopify fires nothing on its own and our renewal cron runs daily, so a same-day
double charge is not reachable, and `migration_completed_at` stays null for the sweeper.

## Gotchas

- **Not idempotent without the marker.** The first real run created TWO live contracts for one
  source (35945087149 + 35945054381) because a retry re-created. `migrated_to_contract_id` is
  written immediately after create; `executeMigration` refuses when it is set.
- **Shopify rejects a past next-billing-date** — on create AND on
  `subscriptionContractSetNextBillingDate`. 0 of the migratable population are past (96 today,
  2,381 future). A due-today date whose clock time passed is nudged a day; anything genuinely stale
  BLOCKS, because inventing a billing date silently reschedules a customer.
  **Consequence for dunning:** it must never write a past date to Shopify — it retries the SAME
  cycle via `billingCycleSelector`, and our own `next_billing_date` (which sits in the past during
  dunning by design) stays the scheduling source.
- **20 contracts have no `deliveryMethod` from Appstle** and no `shipping_address` in our mirror.
  The payment method's **billing address** resolves 15 (a sub with no shipping address ships to the
  billing address). The remaining 5 lack `lastName`/`city` and need manual handling, not a guess.
- **Discounts ride along on the atomic create** — `SubscriptionAtomicLineInput` is
  `{ line, discounts }`, scoped per line. No window where the contract exists at MSRP with
  discounts unapplied, and no `entitledLines` bookkeeping.
- **The snapshot plans; the source decides.** `detectDrift` aborts if the contract changed since the
  snapshot — migrating stale state would silently undo a customer's own edit.

## Measured over all 2,478 snapshots (2026-09-10, re-verified after review)

```
revenue   $188,249.42 → $182,128.50 per cycle   (−3.3%)
455 down     1,553 unchanged     0 UP
blocked 14   (11 no payment method, 2 cancelled, 1 no lines after rules)
grandfather locks 1,883        variant remaps 338        unresolvable lines 0
```

⚠️ **The delta is measured on Shopify's real LINE TOTALS, post-code on both sides** — not
`unit × qty`. Those differ by `standardLine mod qty`, and that remainder lands on the customer: a
unit-based comparison printed `UP 0` while 42 contracts genuinely paid 1–6¢ more. The planner now
absorbs the remainder into the grandfather, so the invariant is true of the amount Shopify actually
charges rather than of our own arithmetic.

⚠️ **`code_allocation_unit_cents` covers ONLY fixed-amount codes** — exactly the ones
`carryableCodes` re-applies. Including percentage codes added their discount to the baseline and
never restored it: 94 contracts would have paid more, +$511.47/cycle, worst case $59.96 → $110.34,
and verify could not see it because both sides were pre-code.

⚠️ **Verify expects `finalUnitCents − carriedCodeUnitCents`** and matches lines by **index**, not
variant. The plan is pre-code while the live contract already has the carried code allocated; and
45 contracts carry the same variant on two lines with different grandfathers, so variant-matching
compared duplicates against the first live line. Both defects aborted the migration — and an abort
brands the contract permanently via `migrated_to_contract_id`.

## Known-open (measured, not fixed)

- **The Appstle-cancel read-back fails open.** A failed verification fetch (`ok:false` — rate
  limit, network, Appstle's HTML-for-unknown-route) is treated as a successful cancel. The sweeper's
  repair path re-cancels with no read-back at all, so a false success is stamped complete on the
  same false success that produced it.
- **A create that succeeds server-side but fails client-side leaves an untracked contract.** The
  marker is written after a *reported* success, so a lost response still allows a duplicate on
  retry — the `35945087149 + 35945054381` case.
- **6 contracts resolve to an incomplete shipping address** and are created anyway.
- **3 partially-consumed limited codes are re-granted in full** (`limit` carried verbatim while
  `usageCount` resets).
- **3 rows are PAUSED in Appstle but `active` locally** — no charge risk (the attempt checks live
  contract status) but permanent no-op churn on a money cron.

## Related

[[../tables/appstle_contract_snapshots]] · [[commerce__shopify-subscription-client]] ·
[[appstle-snapshot]] · [[../inngest/shopify-subscription-renewals]] · [[../lifecycles/shopcx-subscriptions]]
