# libraries/commerce__replacement

Replacement order read and mutation operations in the Commerce SDK.

**File:** `src/lib/commerce/replacement.ts`

**Status:** Display operations shipped (Phase 2 complete). Mutation operations planned per [[../reference/commerce-sdk-inventory.html]].

## Exports

### Display (reads)

**`getReplacement(workspaceId, replacementId) → ReplacementView`**
- Retrieves a single replacement with fully enriched view (items, reason, sub-adjustment).
- Per [[../reference/commerce-sdk-inventory.html]], ReplacementView includes items, reason for replacement, and any subscription adjustments.

**`listReplacementsByCustomer(workspaceId, customerId, filters?) → ReplacementView[]`**
- Lists all replacements for a customer, paginated by cursor on `updated_at + id` per [[../README.md]] § Probing technique.
- Supports filtering by status and date range.

**`listReplacements(workspaceId, filters?) → ReplacementView[]`**
- Lists all replacements in a workspace, paginated by cursor.
- Backed by Postgres RPC for performance.

### Types

**`export type { ReplacementView }`**
- Canonical replacement view, re-exported from [[./types]] (commerce SDK internal type set).

## Design notes

A replacement is created from a source order and can adjust the linked subscription's next billing date — that side effect belongs on the Mutation op, not on any surface.

## See also

[[../reference/commerce-sdk-inventory.html]] — Full SDK structure and Phase sequencing.
[[./types]] — Commerce SDK type definitions.
