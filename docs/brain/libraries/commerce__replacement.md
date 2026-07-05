# libraries/commerce__replacement

Replacement order mutations in the Commerce SDK.

**File:** `src/lib/commerce/replacement.ts`

**Status:** Phase 1 surface declared (Phase 1 complete). Implementations arrive in M2b/M2c per [[../reference/commerce-sdk-inventory.html]].

## Exports

**`export type { ReplacementView }`**
- Canonical replacement view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

A replacement is created from a source order and can adjust the linked subscription's next billing date — that side effect belongs on the Mutation op, not on any surface.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[./types]] — Commerce SDK type definitions.
