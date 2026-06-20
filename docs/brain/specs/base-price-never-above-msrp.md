# Base Price Never Above MSRP (invariant + cap) ⏳

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" ([[../lifecycles/subscription-billing.md]]). The simple root fix behind stuck sub `fdc1d5e3` (Lisa Baker) — and the whole "baseline over-counted" class.

**Definition (precise):** the **base price** is the **per-unit price BEFORE the 25% S&S discount and quantity breaks** — the starting number the pricing engine *applies those rules to*. It's what `subscriptions.items[].price_override_cents` holds. The engine then takes base → −25% S&S → −quantity-break → charged price.

**The invariant:** that base price must **never exceed the catalog MSRP**. `price_override_cents` exists ONLY to preserve a **grandfathered base below MSRP**; at MSRP the engine already produces the correct rules price, so an override **≥ MSRP is at best a no-op and at worst inflates the charge** (a base above list feeds the 25%+quantity-break math from too high a starting point).

**The bug (Lisa Baker).** `inferAppstleLineBase` reverse-engineers the base from `currentPrice/(1−sns)`; for some contracts that yields a base **above MSRP**, which gets stored as `price_override_cents`. The engine then computes a price **higher** than her real charge → `pricing_preserved` fails. Lisa's correct price is **$110.34** — exactly what the rules produce from a **base of MSRP** (2× Amazing Coffee, MSRP base → quantity-break/S&S → $110.34). Her override pushed it to ~$119.92. Capping her base at MSRP (i.e. dropping the over-MSRP override) lets the engine derive $110.34 → the check passes. No baseline-recapture re-architecture needed — just enforce the cap.

## Fix
1. **Enforce on write (migration).** In `inferAppstleLineBase` / `appstleLinesToInternalItems` (`src/lib/migrate-to-internal.ts`): a base is only "grandfathered" when **strictly below MSRP**. If the inferred base is **≥ MSRP**, **do NOT set `price_override_cents`** (leave it null → the engine uses MSRP + rules). Strengthen the existing "only if < MSRP" guard so it can never store an at-or-above-MSRP base (clamp/drop, per line, against the catalog `product_variants` MSRP).
2. **Enforce in the fixer.** `price_reconcile` (`src/lib/migration-fix.ts`) must **reject/clamp** any proposed `price_override_cents > MSRP` — the agent can never reconcile a sub *upward* past MSRP. (Reuse the same MSRP lookup.)
3. **Repair stranded subs.** Anywhere an existing `price_override_cents > MSRP` is found, **drop it to null** (or clamp to MSRP) → the engine re-derives the correct rules price. Surface as a `price_reconcile` proposal (drop the over-MSRP override) the migration-fix agent can apply, OR a backfill sweep. First use: **Lisa (`fdc1d5e3`)** → drop her over-MSRP override → engine → **$110.34** → `pricing_preserved` clears.

## Why this is the simpler fix
The alternative (capture `pre_migration_charge_cents` from resolved pricing instead of the raw line sum) re-architects the audit baseline. This instead enforces one invariant — **base ≤ MSRP** — at every write + repairs violations. The engine already knows how to price correctly from an MSRP base; we just stop feeding it an impossible (above-MSRP) base.

## Verification
- A migration whose `inferAppstleLineBase` yields a base ≥ MSRP → **no** `price_override_cents` stored; the engine prices from MSRP + rules; audit `pricing_preserved` passes on the first pass.
- Lisa (`fdc1d5e3`): drop her over-MSRP override → engine subtotal = **$110.34** → row clears from `/dashboard/migrations`.
- `price_reconcile` proposing an override > MSRP is rejected/clamped (the agent can't raise a sub above MSRP).
- Negative: a genuine grandfathered base **below** MSRP is preserved unchanged (this only touches at-or-above-MSRP overrides).

## Phase 1 — invariant on write + in price_reconcile + repair Lisa ⏳
The `< MSRP` guard hardening in `migrate-to-internal.ts`; the `> MSRP` clamp/reject in `migration-fix.ts` `price_reconcile`; drop Lisa's over-MSRP override → re-verify. Brain: [[../libraries/migrate-to-internal]] + [[../libraries/migration-fix]] + [[../lifecycles/subscription-billing.md]] + [[migration-fix-agent]]. **Queue after [[migration-shipping-protection]] + [[migration-fix-remove-line]] merge** (all three touch `migrate-to-internal.ts` / `migration-fix.ts`). Fold on ship.
