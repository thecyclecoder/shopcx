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

### `REPLACEMENT_MAX_UNITS_PER_VARIANT` — constant

```ts
export const REPLACEMENT_MAX_UNITS_PER_VARIANT = 4;
```

Hard ceiling on units of a single variant per replacement, set by the CEO on 2026-08-02. A 4 + 4 multi-flavour replacement is allowed; 8 of one flavour is refused. The cap lives in the SDK so every caller (portal, script, agent, executor) inherits it.

### `findVariantOverCap` — function

```ts
function findVariantOverCap(items: ReadonlyArray<{ variantId: string; quantity: number; title?: string }>): { variantId: string; title: string | null; requested: number; cap: number } | null
```

Pure predicate for the per-variant cap. Sums quantities by variantId across the items array (two line items for the same variant sum) and returns the first variant that exceeds `REPLACEMENT_MAX_UNITS_PER_VARIANT`, or null when every variant is within the cap. Exposed so callers can pre-check without invoking the full SDK.

### `createReplacementOrder` — function

```ts
async function createReplacementOrder(input: CreateReplacementInput) : Promise<CreateReplacementResult>
```

Enforces the per-variant cap via `findVariantOverCap()` BEFORE inserting the row or calling Shopify. Returns a refusal with the standard failure shape (`success:false, replacementId:'', shopifyOrderName:null, error:...`) if any variant exceeds the cap.

### `CreateReplacementInput` — interface

### `CreateReplacementResult` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

- **Per-variant cap is enforced BEFORE any Shopify call or DB insert.** The CEO ceiling `REPLACEMENT_MAX_UNITS_PER_VARIANT = 4` is guarded by `findVariantOverCap()` at the start of `createReplacementOrder()`, so every caller (portal, script, agent, executor) inherits it. A request that would exceed the cap returns failure (`success:false`) BEFORE the row is inserted or Shopify is called — the caller then decides whether to split, drop the excess, or escalate. We do NOT silently truncate. The predicate sums by variantId across line items, so 4+4 multi-flavour passes but 3+3 of one flavour refuses.

- **Country code normalization is loud on failure.** When resolving the destination address for a replacement, [[country-iso2]] normalizes the countryCode via `normalizeCountryToIso2Strict()` — it maps full names ('United States') and blanks to the customer's/order's/store's real country, and returns `null` for unresolvable inputs like "UN" (the bug from SC132221). A `null` result fails the replacement LOUDLY with `status='failed'` + `reason_detail` — not a silent stall at `address_confirmed`. This prevents the 17-day rot pattern where Shopify silently rejects a bogus code and the replacement never surfaces (see [[replacement-stall]] + ticket 2770a32a).

- **One call, one order, N line items.** `createReplacementOrder` now accepts `input.items[]` with multiple variant IDs, creating ONE Shopify draft order with N line items in a single call. Previously, a 2-flavor replacement fragmented into 2 orders (SC134462 + SC134463). Keep single-item back-compat for existing callers; pass `items: [{ variantId }]` if you have one variant.

## Status / open work

**Shipped:**
- CEO per-variant cap (max 4 units per variant) enforced at SDK entry point `createReplacementOrder` via `findVariantOverCap()` predicate (Phase 1).
- Countrycode normalization with loud failure on unresolvable codes.
- Multi-item replacement creates one order with N line items.
- Stalled replacement detection + `superseded` status — see [[replacement-stall]].

**Known gaps / not yet shipped:**
- Phase 2 & 3 queued for follow-up sessions.

**Recent activity:**
- Per-variant cap enforced: `REPLACEMENT_MAX_UNITS_PER_VARIANT = 4` and `findVariantOverCap()` guard all callers.
- Countrycode normalization tightened; unresolvable codes now fail loudly instead of silently.
- Multi-item support added to `createReplacementOrder`.
- Stalled replacement reconciliation integrated via [[replacement-stall]].

**Open questions:** None

---

[[../README]] · [[../../CLAUDE]]
