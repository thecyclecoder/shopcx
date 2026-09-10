# `appstle_contract_snapshots`

Point-in-time copies of Appstle subscription contracts, taken so the Appstle→ShopCX migration can be
planned and **re-planned** without re-hitting a metered vendor API on every dry run.

Written by [[../libraries/appstle-snapshot]] (`snapshotAppstleContract`), driven by
`scripts/_snapshot-appstle-contracts.ts`. Migration design: [[../lifecycles/shopcx-subscriptions]].

## Why this table exists

**Appstle bills per API call** ([[../integrations/appstle]]). ~2,477 contracts migrate, so reading
live on each dry run costs 2,477 hits *every time*. Snapshot once → every later planning pass is free.

**Our own `subscriptions` mirror cannot substitute for it.** Verified 2026-09-10 on contract
`27852046509`: `subscriptions.items[].price_cents` mirrors Appstle's `currentPrice` — the price
**before** discount allocations. That customer's mirror says `$59.96`; they actually pay `$52.46`
(`lineDiscountedPrice`). The migration prices off what the customer *actually pays*, which the
mirror does not carry at any column. The mirror also drops SKUs the source has (9 lines) while
still resolving by `variant_id`.

It is NOT universal — in a 10-contract sample, 0 of 11 lines had allocations and mirror == effective
throughout. The mirror is right *most* of the time, which is precisely why it can't be trusted for
pricing: the failures are invisible without the source.

## Measured on the full pull (2,477 contracts, 2026-09-10, 0 fetch errors)

| | |
|---|---|
| payment methods | ShopPay **994 (40.1%)** · CreditCard **930 (37.5%)** · PayPal **542 (21.9%)** · none **11** |
| **revoked** payment methods | **0** — the "can't migrate" cohort is 11 contracts, not hundreds |
| mirror `next_billing_date` vs Appstle | 2,413 agree · **64 disagree (2.6%)** |
| direction of disagreement | mirror is **always behind**, never ahead — median **112 days**, max 168 |
| unresolved lines (SKU → variant_id) | **0** |
| true per-cycle revenue, active subs | **$190,133.13** today → **$184,173.70** after migration (**−3.1%**) |
| subs whose price increases | **0** |

⭐ **60% of the base is not a credit card.** Anything keying on last4 / expiry / brand mis-handles
Shop Pay and PayPal.

⭐ **The mirror-date staleness is why this table exists.** Had the migrator taken
`next_billing_date` from `subscriptions`, 64 contracts would have been created with billing dates
up to 5½ months in the PAST — an immediate wrong charge or a schedule broken from birth.

⭐ A mirror-derived estimate of the revenue impact said **−5.3%**; the truth from
`lineDiscountedPrice` is **−3.1%**. The mirror overstated *current* revenue by $6,245/cycle because
it cannot see discount allocations at all.

## Shape

| column | notes |
|---|---|
| `appstle_contract_id` | the Shopify contract id Appstle manages (bare numeric). Unique per workspace. |
| `subscription_id` | our mirror row. **Null = Appstle knows a contract we don't** — the revenue-losing direction. |
| `status`, `next_billing_date`, `billing_interval(_count)`, `delivery_price_cents` | projection |
| `payment_method_id` / `_revoked` / `_type` | a revoked or absent method means the contract **cannot** be recreated under our app |
| `lines` | normalized; see below |
| `raw` | ⭐ **authoritative** — the untouched Appstle response |
| `fetch_error` | set when the fetch failed; `raw` is then null |
| `fetched_at` | staleness clock |

### `lines[]`

| field | meaning |
|---|---|
| `current_price_cents` | per-unit **before** discount allocations — what our mirror stores. Not what they pay. |
| `discounted_total_cents` | Appstle's `lineDiscountedPrice`, which is a **LINE TOTAL**, not a unit price |
| `effective_unit_cents` | ⭐ `discounted_total / quantity` — **the migration's actual input** |
| `discount_allocation_count` | >0 means `current_price_cents` is misleading |

## Gotchas

- **`raw` wins.** The typed columns are a convenience projection, re-derivable from `raw` at any
  time with no further API cost. If a typed column and `raw` disagree, `raw` is right.
- **A snapshot is not a licence to write from it.** The migrator re-reads the single contract it is
  about to move and aborts on drift. This table drives PLANNING only.
- **A failed fetch still writes a row** (`fetch_error` set, `raw` null). A missing row would be
  indistinguishable from "never attempted" — the same silent-gap class as a green heartbeat over a
  sync that wrote zero rows.
- **⚠️ Appstle answers an unknown route with HTTP 200 and its admin SPA's HTML**, not a 404. So
  `res.ok` proves nothing; `fetchAppstleContract` sniffs for a leading `<` before parsing. Any other
  Appstle caller doing `if (res.ok) return res.json()` is exposed to this.
- **Money arrives as decimal strings, sometimes with fractional cents** (`"59.963"`,
  `"239.852"`). Rounded to cents on the way in; migration must not re-introduce fractions.
- **Payment methods are not all cards.** Observed `CustomerCreditCard`,
  `CustomerShopPayAgreement`, and `CustomerPaypalBillingAgreement`. Anything keying on card
  fields will silently mis-handle the latter two.

## Related

[[../libraries/appstle-snapshot]] · [[../integrations/appstle]] · [[subscriptions]] ·
[[../lifecycles/shopcx-subscriptions]] · [[../libraries/commerce__shopify-subscription-client]]
