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

## ⭐ Carrying the customer's dates across

A new contract's cycle calendar starts at *its* `createdAt`, so a migrated sub would otherwise be
re-based onto migration day. Two things preserve the real dates, and only the second one holds:

1. **`anchorsForSchedule()` on create** — sets `billingPolicy.anchors` so the contract is at least
   born phased. This is the weaker half: an anchor is a day-of-month / day-of-week, so it phases
   `MONTH` correctly and **cannot phase `WEEK`/n at all** — and 96% of this book is `WEEK`/4 or
   `WEEK`/8.
2. **`shopifySyncBillingSchedule()` immediately after create** — walks the customer's own cadence
   forward from their real next billing date, pinning each cycle with
   `subscriptionBillingCycleScheduleEdit`. Works for every cadence. Verified end to end: a `WEEK`/8
   contract went from `11-12 / 01-07 / 03-04 / 04-29` to `09-21 / 11-16 / 01-11 / 03-08`.

Non-fatal and dry-run-aware — a migration whose schedule sync fails is still a correctly-priced,
correctly-dated contract in our own records, and the next renewal re-pins it. Full mechanism table:
[[commerce__shopify-subscription-client]] § "Keeping a customer's own dates".

## ⭐ Wave 1 — 25 real contracts, 2026-09-18

What it proved, and what it broke.

**Result:** 24 of 25 swapped (the 25th correctly refused by the drift guard), 0 duplicates, 0 missing items or addresses, 0 past-due dates, $3,056.87/cycle
now billed by ShopCX. Appstle confirmed `CANCELLED` on all 23 by live read. The 2 that did not swap
are still billed by Appstle — **every customer in the cohort is billed by exactly one engine.**

**Two defects it exposed, both in the verifier:**

1. **`atomicCreate` does NOT preserve line order.** The verifier matched plan line *i* to live line
   *i*, and **10 of 25 contracts came back permuted** — every SKU present, every position different
   — so 10 correctly-priced contracts failed verify. The old comment asserted order was preserved;
   it is not. Now matched by variant with **best-fit pairing on effective price**, which is
   order-independent AND still separates two same-variant lines at different grandfathers (45
   contracts carry those, and first-match-wins fails them).

2. **No resume path.** A verify failure leaves a created, inert contract and a snapshot branded with
   `migrated_to_contract_id` — after which a plain re-run can only say "already migrated". All 24
   created contracts were stranded that way. `executeMigration(..., {resume:true})` now re-enters at
   the VERIFY step against the contract that already exists.
   ⚠️ **A resume NEVER re-applies customer codes.** They are fixed-amount discounts; re-adding them
   to a contract that already carries them silently doubles the customer's discount. Resume verifies
   what exists, it does not re-apply.

**The safety design held exactly as written.** `completeSwap` defaults false, so the whole wave
stopped in the reversible middle state: contracts created, `billing_source` untouched, every
customer still billed by Appstle. Nothing was double-charged and nothing was stranded without a
biller. The PDP ingest claim guard also held — all 24 new contracts fired
`subscription_contracts/create`, and all 24 were correctly refused as "created by the Appstle
migration" ([[commerce__shopcx-contract-ingest]]).

**Pricing:** 11 of 24 got cheaper (the quantity break they qualified for and never had), 13
unchanged, **none more expensive** — −$173.81/cycle, −5.7%. CEO approved applying standard rules.

**Two more defects found completing the wave (both fixed):**

3. **`entitledLines` must be `{ all: true }` when unscoped.** Omitting it does NOT mean "no scoping"
   — Shopify defaults it to an empty set and rejects with *"Entitled lines may not be empty"*.
   Exactly ONE contract in wave 1 carried a customer code, and it failed on this; **132 contracts in
   the book carry codes**, so it would have failed every one of them. Probed directly against a live
   inert contract: omitted → rejected, `{all:true}` → accepted. Fixed in `normalizeEntitledLines`.

4. **The swap never re-mirrored `subscriptions.items`.** It repoints the row and flips the engine,
   but leaves the APPSTLE-ERA prices in place — so the portal and CS keep quoting the old number
   while the contract charges the new one. **13 of 25 rows showed a price HIGHER than the contract
   would charge, by up to $43.13.** It errs in the customer's favour, which is precisely why nothing
   would ever have complained about it. `mirrorContractPricing` now runs after every swap
   (non-fatal — a stale price is a display bug, not a failed migration), and
   `scripts/_backfill-migrated-pricing-mirror.ts` corrected the 13.

**A migration that fails at `codes` cannot be resumed** — resume never re-applies codes, so the
codes stay missing forever. The recovery is `scripts/_remigrate-broken.ts`: cancel the inert
contract, VERIFY the cancel, only then clear the markers, and migrate again from scratch. Safe
because the customer is billed by Appstle throughout. Proved on 27832090797 → 36064592045.

**Pre-flight before the first renewals:** `scripts/_preflight-renewals.ts` replays the cron's
selection and per-sub cycle resolution for a future date without charging. All 24 resolve to cycle
#1 UNBILLED across 09-22..09-28, $3,056.87 total, zero strands.

## Wave 1b — 20 more, due the NEXT day (2026-09-18)

Wave 1's earliest renewal was four days out, which is four days before the untested decline path
says anything. So a second batch was picked for **exactly the next calendar day** (`--due`), to get
the answer in one cron tick instead of a week.

**19 of 20 swapped. ZERO verify-pricing failures** — against 10 of 25 in wave 1, which is the
line-ordering fix measured rather than asserted. The 20th was refused by the drift guard (customer
edited since the snapshot), same as wave 1's one refusal.

**43 of 43 real source contracts confirmed `CANCELLED` on Appstle by live read** — no customer is
billed by both engines. (The 44th flagged row is a self-referential 09-10 test artifact on the
founder's own account, already `cancelled` with a null billing date.)

One pricing mirror failed on a transient `fetch failed` and was caught because it is non-fatal and
logged — `_backfill-migrated-pricing-mirror.ts` corrected it. That is the intended shape: a display
bug that reports itself rather than a migration that looks failed.

**Pre-flight for the 19th:** all 19 resolve to cycle #1 UNBILLED, **$1,791.06** due in one tick.

**Still open from the wave:**
- `27847327917` — drift guard refused it (the customer edited since the snapshot). Correct.

## ⭐ `--refresh` — re-snapshot immediately before migrating

The snapshot PLANS a migration and `detectDrift` refuses if the contract changed since. Correct,
and the reason **2 of 45 contracts were refused across waves 1 and 1b**. That refusal rate is a
function of **snapshot age**: every day more customers edit their subscription and quietly become
un-migratable until someone re-pulls them. The snapshots were 11 days old by 2026-09-21.

`scripts/_run-migration-wave.ts --refresh` re-snapshots each target right before migrating it, so
the plan is current and the only drift that can fire is a change in the intervening seconds —
exactly the window the check should be guarding. One extra metered Appstle call per contract,
scoped to the wave.

A failed refresh SKIPS that contract rather than falling back to stale data.

Proved on 2026-09-21: a 5-contract wave went 5/5 **including `27847327917`, which wave 1 had
drift-refused** — the refresh fixed precisely the failure it was built for. The in-swap pricing
mirror also needed 0 corrections afterwards, confirming that fix landed too.

**This is the default for any wave past a handful.** Without it, the refusal rate climbs with the
age of the snapshot table and the misses are silent — a refused contract just stays on Appstle.

## Wave 2 — 126 contracts across 7 due dates, 2026-09-21

First wave run with `--refresh` on, and the first one that found **no new defects**.

**123 of 126 migrated and swapped.** 0 missing items, 0 missing addresses, 0 duplicate rows,
**0 pricing-mirror corrections** (the in-swap mirror works), **drift 0 of 179**.
**128 of 128 confirmed `CANCELLED` on Appstle by live read** — no customer billed by both engines.

Population now: **178 on ShopCX ($16,758.33/cycle), 1,831 still active on Appstle.**

Deliberately spread 18/day across 09-22..09-28 so renewals arrive in daily batches small enough to
watch, rather than one cliff.

### The 3 refusals — all safe, all left on Appstle

- **2 × drift**, even with `--refresh`: the contract changed between the re-snapshot and the
  migration seconds later. That is the guard doing exactly its job in the window it was narrowed to.
- **1 × verify-pricing** (`27947565229`): `Insure01` effective 549 vs planned 600, and
  `SC-TABS-BERRY` 5043 vs 5041. The 2-cent one is multiplicative rounding across 3 allocations; the
  51-cent one on shipping protection is a genuine pricing disagreement worth chasing before a
  full-book sweep, since protection rides on many contracts. **Do not widen the ±1c tolerance to
  make this pass** — it would mask the real half.

### Two rates to keep watching (both still too small to conclude from)

- **declines:** 3 of 19 in the first renewal batch (15.8%) vs a book-wide baseline near 6%. At 6%
  the expected count was 1.2, so 3 is not yet a signal. Wave 2's renewals over 09-22..09-28 are the
  sample that settles it. If it holds near 15% across hundreds, that is a payment-method problem the
  migration is EXPOSING, not causing.
- **pauses:** 2 of 19 paused within a day of renewing, both 60-day.

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

## Hard-won invariants (each of these was a real defect first)

- **The Appstle-cancel verification fails CLOSED.** It once read `after.ok && status !== "CANCELLED"`,
  so a verification we could not *perform* (rate limit, network, Appstle's HTML-for-unknown-route)
  counted as one that passed. The sweeper's repair path had no read-back at all, so a false success
  was stamped complete on the same false success that produced it — and a stamped row leaves the
  sweeper's query forever. Both now verify, and refuse to stamp when they cannot.
- **The create attempt is stamped BEFORE the call.** `migrated_to_contract_id` is written after a
  *reported* success, so a create Shopify committed whose response was lost left no trace and a
  retry duplicated it (35945087149 + 35945054381). With `migration_attempted_at`, a retry queries
  the customer's contracts created since that stamp and ADOPTS the orphan — or refuses if more than
  one is found. Marker write failures now abort rather than being discarded.
- **An incomplete shipping address BLOCKS, at plan time.** `MailingAddressInput` requires nothing,
  so Shopify accepts a half-address and the box has nowhere to go. Validated by ONE resolver shared
  by planner and executor — when only the executor checked, the planner counted those contracts as
  migratable and they failed at write time.
- **A partially-consumed code carries its REMAINING cycles.** `usageCount` resets to 0 on a new
  contract, so copying `recurringCycleLimit` verbatim re-granted the whole run — a code at 2 of 3
  gave 3 more cycles instead of 1.

## Blocked population (19 of 2,478)

```
no_payment_method                            11
contract_cancelled                            2
incomplete_address:lastName                   3
incomplete_address:city+lastName              1
incomplete_address:address1+city+lastName     1
no_lines_after_rules                          1
```

## Still open

- **3 rows are PAUSED in Appstle but `active` locally.** No charge risk — the renewal attempt checks
  the live contract status — but permanent no-op churn on a money cron.
- **13 protection lines carry a source discount allocation**, baked into `baseCents`; a carried
  contract-level code then allocates to that line again. Cents-scale.
- **Structural discounts have no `recurringCycleLimit`**, so they persist — intended, but nothing
  re-verifies pricing over a contract's life.

## Related

[[../tables/appstle_contract_snapshots]] · [[commerce__shopify-subscription-client]] ·
[[appstle-snapshot]] · [[../inngest/shopify-subscription-renewals]] · [[../lifecycles/shopcx-subscriptions]]
