# libraries/commerce__return

Return mutations in the Commerce SDK. Handles return lifecycle and refund issuance.

**File:** `src/lib/commerce/return.ts`

**Status:** Phase 1 surface declared (Phase 1 complete). Implementations arrive in M2b/M2c per [[../reference/commerce-sdk-inventory.html]].

## Exports

**`export type { ReturnView, ReturnLineView }`**
- Canonical return and line item views, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

Returns refund on EasyPost `delivered` (not carrier first-scan), and `net_refund_cents` is set at creation and MUST be trusted at refund time — the Mutation op enforces that invariant.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[./types]] — Commerce SDK type definitions.
