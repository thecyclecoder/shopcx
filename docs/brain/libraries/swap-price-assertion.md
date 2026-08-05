# libraries/swap-price-assertion

Pure never-raise assertion for a variant swap on either rail. Compares the post-swap realized price against the EXPECTED price the [[../libraries/commerce__price]] rules engine produces, rather than against whatever the line happened to cost before. The guard exists because `callReplaceVariants` returns 2xx-success without reading the body, and on 2026-07-30 286 subscriptions silently reset to catalog before anyone noticed. That protection must survive — but the old baseline (captured realized) was only meaningful while quantity stayed unchanged. When a customer reduces their quantity, the per-unit rate legitimately moves (dropping from qty 2 to qty 1 forfeits the buy-two discount, so per-unit price correctly increases). Comparing against the rules-derived expectation keeps working when quantity changes: a catalog reset still lands far above the expectation and fails loudly; a legitimate recomputation matches the expectation and passes.

**File:** `src/lib/swap-price-assertion.ts`

## Exports

### `assertSwapDidNotRaise` — function (pure predicate)

```ts
function assertSwapDidNotRaise(input: {
  expectedRealizedCents: number;
  observedRealizedCents: number;
  quantity: number;
  contractId: string;
  toleranceCents?: number;
}): string | null
```

**Why it exists:** [[../libraries/subscription-items]] `subSwapVariant` and [[../libraries/internal-subscription]] `internalSubSwapVariant` call [[../libraries/commerce__price]] `resolveSubscriptionPricing` on the post-swap items to compute what the rules say that line SHOULD cost at its new variant and new quantity, then pass that expectation here. This pure predicate is the POST-SWAP enforcement gate that verifies the observed realized didn't exceed what the rules produce — a swap that would raise the price above the rules is returned as `success: false` to the caller rather than silently succeeding.

**Semantics:**
- `observed > expected + tolerance` → **RAISE** → returns a human-readable error string naming the contract, expected, observed prices, and quantity.
- At-or-below expected is always fine (a cheaper realization than the rules is always allowed).
- `quantity` is included in the error message so support and customers can see why (e.g. "quantity 1 forfeited the buy-two discount, so per-unit price went up").
- `toleranceCents` defaults to 2¢ so legitimate `Math.round` drift on arithmetic base-solve doesn't flip; anything bigger is a real regression.
- Returns `null` when the invariant holds (no error).

**Pure.** Broken out so the predicate can be unit-tested directly without standing up a subscription or Appstle vendor mock. Takes the expectation as an input (computed by callers via `resolveSubscriptionPricing`) so the guard stays free of DB access.

### `PriceGuardRefusal` — interface

```ts
interface PriceGuardRefusal {
  contractId: string;
  expectedRealizedCents: number;
  observedRealizedCents: number;
  quantity: number;
  reason: "swap_raises_over_rules";
}
```

Distinct refusal class — a price-guard refusal is US deliberately declining to proceed because the post-swap realized price exceeds the rules-derived expectation, NOT a vendor failure. Both the Appstle rail (`subSwapVariant` in [[../libraries/subscription-items]]) and the internal rail (`internalSubSwapVariant` in [[../libraries/internal-subscription]]) emit this shape on refusal, so downstream response classifiers can tell it apart from a real vendor error (a 5xx, a decline body, a network timeout). Ticket e2a55cfb (Isabel Disciullo, 2026-08-05): her portal replacevariants failure on internal contract `internal-8922b5701b2f45ea` was mislabeled as an Appstle vendor error even though Appstle was not involved at all — the internal rail's own guard refused it. The `reason` discriminator is what prevents this mislabel.

### `describePriceGuardRefusal` — function

```ts
function describePriceGuardRefusal(r: PriceGuardRefusal): string
```

Build a customer-facing message for a price-guard refusal. Explains that the change would raise the per-unit price above what the rules produce, and (when quantity ≤ 1) attributes it to a volume discount no longer applying — so support and the customer both see a decision rather than a fault. Kept pure so consumers can render it uniformly (portal 422 body, action-executor reason, journey-complete telemetry) without duplicating copy.

## Callers

- `src/lib/subscription-items.ts` — `subSwapVariant` computes expected price via `resolveSubscriptionPricing` and calls `assertSwapDidNotRaise` on the Appstle rail; on refusal, returns `PriceGuardRefusal` to caller
- `src/lib/internal-subscription.ts` — `internalSubSwapVariant` computes expected price via `resolveSubscriptionPricing` and calls `assertSwapDidNotRaise` on the internal rail; on refusal, returns `PriceGuardRefusal` to caller
- `src/lib/portal/helpers.ts` — `handlePriceGuardRefusal` classifies a price-guard refusal as distinct from vendor errors (status 422, error code `price_guard_refusal` instead of `appstle_error`), and renders the customer-facing message via `describePriceGuardRefusal`

## Spec

[[../specs/swap-price-guard-compares-against-the-pricing-rules-not-the-old-price]] — rebase the assertion to compare against the rules-derived expected price rather than the captured-before price, add the distinct refusal class for honest error classification on both rails, and pin the anchor cases (quantity-driven per-unit increase MUST pass; catalog reset MUST fail).

---

[[../README]] · [[../../CLAUDE]]
