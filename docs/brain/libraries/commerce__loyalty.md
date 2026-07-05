# libraries/commerce__loyalty

Loyalty program read and mutation operations in the Commerce SDK.

**File:** `src/lib/commerce/loyalty.ts`

**Status:** Display operations shipped (Phase 3 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getLoyaltyBalance(workspaceId, customerId) → LoyaltyView`**
- Retrieves a loyalty member's current balance, tiers, redemptions, and dollar value.
- Per [[../reference/commerce-sdk-inventory.html]], LoyaltyView includes balance, tiers, redemptions, and dollar value.

**`listLoyaltyLedger(workspaceId, customerId, filters?) → LoyaltyRedemptionTierView[]`**
- Lists all loyalty ledger entries (adjustments, redemptions, tier changes) for a customer.
- Paginated by cursor for large histories.
- Consumed by dashboard and customer-facing UIs for transparency.

### Types

**`export type { LoyaltyView, LoyaltyRedemptionTierView }`**
- Canonical loyalty member and redemption views, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Balance mutators re-read the live row before writing (see [[../libraries/loyalty]] gotcha) — the Mutation op wraps that discipline so callers never trust a stale `member` snapshot.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../libraries/loyalty]] — Core loyalty logic and mutation discipline.
[[./types]] — Commerce SDK type definitions.
