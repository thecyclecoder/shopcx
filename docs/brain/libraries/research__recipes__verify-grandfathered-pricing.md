# libraries/research/recipes/verify-grandfathered-pricing

Recipe: was grandfathered pricing preserved?

**File:** `src/lib/research/recipes/verify-grandfathered-pricing.ts`

## File header

```
verify_grandfathered_pricing — proactive recipe. Detects when a
customer's active subscription line items are priced HIGHER than
what their historical order pattern shows they used to pay.
Doesn't require an AI claim to trigger — fires whenever the analyzer
flags a severe issue on a ticket where the customer has at least
one active sub. The signal is purely structural: median historical
sub-rate vs current sub-rate, per variant.
Gap type:
pricing_drift:<contract_id>:<variant_id> — current price > historical typical price by ≥$4 AND ≥5%
Proposed heal:
update_line_item_price with base = historical_unit_price / 0.75
(Appstle applies the 25% sellingPlan discount → customer pays the
historical rate at next renewal.)
Skips proposing a heal (escalates instead) when:
- <3 historical orders for the variant (single anomaly, can't be sure)
- The historical price was a clear one-time MSRP outlier (no repeats)
```

## Exports

### `verifyGrandfatheredPricing` — const

```ts
const verifyGrandfatheredPricing: ResearchRecipe
```

## Callers

- `src/lib/research/index.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
