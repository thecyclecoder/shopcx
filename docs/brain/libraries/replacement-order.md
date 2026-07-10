# libraries/replacement-order

`createReplacementOrder()` — builds + completes a Shopify draft order at no charge to the customer. Stamps with `replacement: true` so downstream events skip marketing attribution + LTV bump. Tracks against `workspaces.replacement_threshold_cents`.

**File:** `src/lib/replacement-order.ts`

## File header

```
Canonical helper for creating a Shopify replacement order AND persisting
it to the `replacements` table.
Use this EVERYWHERE we create a replacement — direct actions, playbook
steps, ad-hoc agent scripts, the agent-facing dashboard. The contract:
1. Insert a `replacements` row FIRST (status='pending') — guarantees
a DB record exists even if the Shopify call fails or the process
dies mid-flight.
2. Create + complete the Shopify draft order.
3. Update the row with the Shopify order name (status='created') OR
mark it 'failed' with the error.
4. Optionally write a [Manual action] system note on the ticket.
This is the single source of truth: if a Shopify replacement order
exists, a `replacements` row exists for it. No silent gaps where the
order shipped but our system doesn't know.
Why a record-first approach: previously the direct action inserted
AFTER the Shopify call inside a try/catch labeled "non-fatal". On any
insert failure (RLS, schema drift, network), the order shipped but
the row was lost. Record-first means the row exists for sure and the
Shopify call updates it with the outcome.
```

## Exports

### `createReplacementOrder` — function

```ts
async function createReplacementOrder(input: CreateReplacementInput) : Promise<CreateReplacementResult>
```

### `CreateReplacementInput` — interface

### `CreateReplacementResult` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

- **Country code normalization is loud on failure.** When resolving the destination address for a replacement, [[country-iso2]] normalizes the countryCode via `normalizeCountryToIso2Strict()` — it maps full names ('United States') and blanks to the customer's/order's/store's real country, and returns `null` for unresolvable inputs like "UN" (the bug from SC132221). A `null` result fails the replacement LOUDLY with `status='failed'` + `reason_detail` — not a silent stall at `address_confirmed`. This prevents the 17-day rot pattern where Shopify silently rejects a bogus code and the replacement never surfaces (see [[replacement-stall]] + ticket 2770a32a).

- **One call, one order, N line items.** `createReplacementOrder` now accepts `input.items[]` with multiple variant IDs, creating ONE Shopify draft order with N line items in a single call. Previously, a 2-flavor replacement fragmented into 2 orders (SC134462 + SC134463). Keep single-item back-compat for existing callers; pass `items: [{ variantId }]` if you have one variant.

## Status / open work

**Shipped:**
- Countrycode normalization with loud failure on unresolvable codes (Phase 1).
- Multi-item replacement creates one order with N line items (Phase 2).
- Stalled replacement detection + `superseded` status (Phase 3) — see [[replacement-stall]].

**Known gaps / not yet shipped:**
- None

**Recent activity:**
- Countrycode normalization tightened; unresolvable codes now fail loudly instead of silently.
- Multi-item support added to `createReplacementOrder`.
- Stalled replacement reconciliation integrated via [[replacement-stall]].

**Open questions:** None

---

[[../README]] · [[../../CLAUDE]]
