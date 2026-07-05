# libraries/commerce__crisis

Crisis campaign operations in the Commerce SDK. Unified surface for reading crisis state and context.

**File:** `src/lib/commerce/crisis.ts`

**Status:** Display operations shipped (Phase 3 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getCrisisContext(workspaceId, customerId) → CrisisView`**
- Retrieves crisis context for a customer (if any active crisis).
- Per [[../reference/commerce-sdk-inventory.html]], CrisisView includes segments, outcomes, and financial impact.
- Returns empty if no active crisis, non-empty if crisis is open.
- Used for dunning, chargeback, and fraud decision gates per [[../lifecycles/crisis-campaign]].

### Types

**`export type { CrisisView }`**
- Canonical crisis view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Crisis reads are lightweight — most callers only need to know "is this customer in crisis?" and the high-level impact. The view carries enough context for dunning and triage to make decisions without a second query.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[../lifecycles/crisis-campaign]] — Crisis campaign lifecycle and decision gates.
[[../tables/crises]] — Crisis table schema.
[[./types]] — Commerce SDK type definitions.
