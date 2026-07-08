# libraries/subscription-renewal-guard

Pre-charge **overcharge guard** for the internal subscription renewal path — the belt & suspenders on the grandfathered-price contract. A pure predicate that answers a single question at the pre-charge junction of [[../inngest/internal-subscription-renewals]]: does the engine's computed charge for each product line stay AT OR BELOW the sub's own configured line ceiling?

**File:** `src/lib/subscription-renewal-guard.ts`

## Why this exists

Phase 1 of [[../specs/subscription-renewal-honors-configured-grandfathered-price-never-bills-standard]] made [[pricing]] `resolveSubscriptionPricing` honor the sub's stored line lock as authoritative on renewal — when an item carries `price_cents` (post-discount lock) or `price_override_cents` (pre-discount base) it flows through as the unit price and catalog + rule decomposition is skipped so a grandfathered customer is never re-priced to the current standard when catalog prices rise.

This guard (Phase 2) is the fail-safe: even if a future repricing regression reintroduces catalog decomposition on a locked line, the guard catches the overcharge **before** the charge is submitted to Braintree. No silent overcharge can reach the customer via the internal renewal path.

Derived from ticket 5402b5d4-e739-46fc-8e9d-b245e7f20f82 — a sub configured at `.95/unit` was billed the `.17` standard on renewal.

## Exports

### `checkRenewalOverchargeGuard(items, computedLines) → RenewalGuardResult`

Pure — no I/O, no DB. Per product line, compares the engine's computed `unit_cents` against that item's configured ceiling:

- Ceiling = `items[].price_cents` if set (post-discount lock), else `items[].price_override_cents` if set (pre-discount base), else **uncapped** (live-catalog opt-in).
- Gifts (`is_gift=true` — unit $0 by design) never contribute a ceiling or a computed amount.
- Shipping protection (flag-billed via `shipping_protection_added` + `_amount_cents`, not a catalog line) is filtered by `kind !== "product"` and never contributes.

Returns `{ ok, reason?, computed_product_cents, configured_cap_cents, offending_lines }`. `ok: true` when every product line stays at or below its ceiling (or the line has no ceiling). `ok: false` with `reason: "overcharge_above_configured"` when any product line's computed unit exceeds its ceiling — the renewal MUST NOT be submitted to the gateway.

## The contract enforced

**A renewal's per-unit is the sub's configured line price + `applied_discounts` — never the product's current standard catalog price.** A computed amount exceeding the configured total is **held**, not billed. See the renewal-price contract in [[pricing]] § The principle and the lifecycle at [[../lifecycles/subscription-billing]] § Phase 2.5.

## Caller

- [[../inngest/internal-subscription-renewals]] `internal-subscription-renewal-attempt` — wired **after** `resolveSubscriptionPricing` and **before** `resolve-coupons` / `avalara-commit` / `insert-pending-transaction` / `braintree-sale`. On a fail:
  1. `emitRenewalOutcomeHeartbeat("skipped_other")` — accounted for in Control Tower's outcome-distribution beats ([[control-tower]]).
  2. Log [[../tables/customer_events]] `subscription.renewal_held_overcharge_guard` — `subscription_id`, `reason`, `computed_product_cents`, `configured_cap_cents`, `offending_lines`.
  3. Return `{ skipped: true, reason: "overcharge_guard_held" }` — the charge is **NEVER** submitted to Braintree at the higher amount.
  4. `next_billing_date` is **intentionally NOT advanced** — a fix + re-run picks the sub back up on the next daily cron tick.

## Testing

`src/lib/subscription-renewal-guard.test.ts` (node:test, 7 cases): at-ceiling passes; above-ceiling fails with the ticket's exact $39.95→$46.17 shape; override ceiling passes both directions; uncapped items never offend; gifts + protection excluded; multi-line reports only the offender. Pinned to the spec's Phase-2 verification bullet: *"A renewal whose computed amount exceeds the sub's configured line total is capped to the configured total (or held + flagged), never submitted to the gateway at the higher amount."*

## Gotchas

- **Post-discount lock takes precedence over pre-discount lock as the ceiling.** When both are set (rare but possible on hand-configured subs), `price_cents` wins — that's the authoritative renewal unit shape, mirroring the engine's ordering.
- **Uncapped ≠ safe.** Items with neither lock are the live-catalog opt-in; a catalog price change flows through by design. The guard passes them through — protecting against catalog creep is the LOCK's job, not the guard's.
- **This is a fail-safe, not the primary defense.** The primary defense is the Phase 1 engine change — `price_cents` / `price_override_cents` are the authoritative unit. The guard exists so a regression there can't silently overcharge; it's the second wall, not the first.

---

[[../README]] · [[pricing]] · [[../inngest/internal-subscription-renewals]] · [[../lifecycles/subscription-billing]] · [[subscription-overcharge]] · [[../../CLAUDE]]
