# libraries/swap-price-assertion

Pure never-raise assertion for a variant swap on either rail. Turned a mispriced post-swap state back into a caller-visible failure instead of a silent success, closing the 2026-07-30 crisis class where `callReplaceVariants` returned 2xx-success on a contract that reset $286-worth of grandfathered prices to catalog.

**File:** `src/lib/swap-price-assertion.ts`

## Exports

### `assertSwapDidNotRaise` — function (pure predicate)

```ts
function assertSwapDidNotRaise(input: {
  capturedRealizedCents: number;
  observedRealizedCents: number;
  contractId: string;
  toleranceCents?: number;
}): string | null
```

**Why it exists:** [[../libraries/subscription-items]] `subSwapVariant` and [[../libraries/internal-subscription]] `internalSubSwapVariant` both capture the outgoing line's realized per-unit price BEFORE the variant replace (Phase 1–2 of [[../specs/swap-variant-preserves-the-line-price]]), then re-apply it to the new line. This pure predicate is the POST-SWAP enforcement gate (Phase 3) that verifies the observed realized didn't exceed the captured one — a swap that raised the price is returned as `success: false` to the caller rather than silently succeeding.

**Semantics:**
- `observed > captured + tolerance` → **RAISE** → returns a human-readable error string naming the contract, expected, and observed prices.
- At-or-below captured is always fine (a cheaper variant is allowed).
- `toleranceCents` defaults to 2¢ so legitimate `Math.round` drift on arithmetic base-solve doesn't flip; anything bigger is a real regression.
- Returns `null` when the invariant holds (no error).

**Pure.** Broken out of `subscription-items.ts` + `internal-subscription.ts` so the predicate can be unit-tested directly without standing up a subscription or Appstle vendor mock.

## Callers

- `src/lib/subscription-items.ts` — `subSwapVariant` Phase 3 assertion on the Appstle rail
- `src/lib/internal-subscription.ts` — `internalSubSwapVariant` Phase 3 assertion on the internal rail

## Spec

[[../specs/swap-variant-preserves-the-line-price]] — Phase 3 (assert it, so a silent regression is impossible).

---

[[../README]] · [[../../CLAUDE]]
