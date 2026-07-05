# libraries/commerce__loyalty

Loyalty program operations in the Commerce SDK.

**File:** `src/lib/commerce/loyalty.ts`

**Status:** Phase 1 surface declared (Phase 1 complete). Implementations arrive in M2b/M2c per [[../reference/commerce-sdk-inventory.html]].

## Exports

**`export type { LoyaltyView, LoyaltyRedemptionTierView }`**
- Canonical loyalty member and redemption views, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Balance mutators re-read the live row before writing (see [[../libraries/loyalty]] gotcha) — the Mutation op wraps that discipline so callers never trust a stale `member` snapshot.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../libraries/loyalty]] — Core loyalty logic and mutation discipline.
[[./types]] — Commerce SDK type definitions.
