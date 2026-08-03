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

### `normalizeReplacementReasonTag` — function

```ts
function normalizeReplacementReasonTag(raw: string | null | undefined): string
```

Normalise a caller's free-form `reason` into a short stable Shopify tag token — lower-case, alphanumerics only, underscores for separators, truncated to `REPLACEMENT_REASON_TAG_MAX_LEN` (40 chars). A blank input falls back to `unspecified`. Called inside `buildReplacementDraftOrderInput` so the emitted tags are always `["replacement", <normalised code>]` — the raw prose reason (e.g., "Customer received two damaged bottles, one leaking, plus expired shipping label") goes to the ORDER NOTE (via `shopifyNote`) where it belongs, not into a tag Shopify will reject at 40 chars.

### `REPLACEMENT_REASON_TAG_MAX_LEN` — constant

`40` — Shopify's per-tag ceiling. A 62-char reason failed a real replacement on 2026-08-02 with 'Title Tag exceeds the maximum length of 40 characters', which reads as nothing to do with tags.

## Callers

_No internal callers found via static scan._

## Gotchas

- **Per-variant cap is enforced BEFORE any Shopify call or DB insert.** The CEO ceiling `REPLACEMENT_MAX_UNITS_PER_VARIANT = 4` is guarded by `findVariantOverCap()` at the start of `createReplacementOrder()`, so every caller (portal, script, agent, executor) inherits it. A request that would exceed the cap returns failure (`success:false`) BEFORE the row is inserted or Shopify is called — the caller then decides whether to split, drop the excess, or escalate. We do NOT silently truncate. The predicate sums by variantId across line items, so 4+4 multi-flavour passes but 3+3 of one flavour refuses.

- **Country code normalization is loud on failure.** When resolving the destination address for a replacement, [[country-iso2]] normalizes the countryCode via `normalizeCountryToIso2Strict()` — it maps full names ('United States') and blanks to the customer's/order's/store's real country, and returns `null` for unresolvable inputs like "UN" (the bug from SC132221). A `null` result fails the replacement LOUDLY with `status='failed'` + `reason_detail` — not a silent stall at `address_confirmed`. This prevents the 17-day rot pattern where Shopify silently rejects a bogus code and the replacement never surfaces (see [[replacement-stall]] + ticket 2770a32a).

- **One call, one order, N line items.** `createReplacementOrder` now accepts `input.items[]` with multiple variant IDs, creating ONE Shopify draft order with N line items in a single call. Previously, a 2-flavor replacement fragmented into 2 orders (SC134462 + SC134463). Keep single-item back-compat for existing callers; pass `items: [{ variantId }]` if you have one variant.

- **Tag vs note split — the reason has TWO homes.** Shopify tags cap at 40 chars per tag; a 62-char free-form reason failed a real replacement on 2026-08-02 with 'Title Tag exceeds the maximum length of 40 characters', which reads as nothing to do with tags. The SDK now emits `tags: ["replacement", normalizeReplacementReasonTag(input.reason)]` — a short stable slug that never rejects the whole order — while `input.shopifyNote` carries the human explanation in the ORDER NOTE (ticket URL auto-appended). Callers pass the free-form prose to `shopifyNote`; the SDK derives the safe tag slug. This closes the mislabelling gap: measured 2026-08-02, 84 of 87 replacements this workspace has ever issued were NOT crisis-related (goodwill bags, expired items, wrong variant, address corrections), yet every single one was recorded in Shopify with 'Replacement order — crisis swap compensation' because that string was hardcoded in `action-executor.ts` `create_replacement_order`. The hardcoded crisis note is gone; the caller's explanation is what Shopify records now.

- **Per-variant replacement cap — 4 units enforced in the SDK.** CEO ruling 2026-08-02: never replace more than 4 units of a SINGLE variant on one order. The cap is PER VARIANT, not per order — a 4 + 4 multi-flavour replacement is fine; 8 of one flavour is not. Recorded in the `exchanges` policy's INTERNAL half as machine rule `exchanges.replacement_max_units_per_variant` (value: 4) via `scripts/_backfill-replacement-cap-policy.ts`, so Sol (via `getAgentPolicyPackage`) and June (via the CS-director brief loader) both state the ceiling consistently. Phase 2 surfaces it in `createReplacementOrder` as a named constant `REPLACEMENT_MAX_UNITS_PER_VARIANT` that refuses (does NOT silently truncate) any line above 4 units, returning an error naming the variant and requested quantity. ⏳ Phase 3 (not yet shipped) will escalate the refusal to the CEO approvals feed via a `dashboard_notifications` row of `type='agent_approval_request'` + `metadata.routed_to_function='ceo'`, so an over-cap request gets a decision instead of a wall.

## Status / open work

**Shipped:**
- CEO per-variant cap (max 4 units per variant) enforced at SDK entry point `createReplacementOrder` via `findVariantOverCap()` predicate.
- Countrycode normalization with loud failure on unresolvable codes.
- Multi-item replacement creates one order with N line items.
- Stalled replacement detection + `superseded` status — see [[replacement-stall]].
- Reason tag/note split: SDK derives a normalised Shopify tag slug via `normalizeReplacementReasonTag`, the free-form prose goes to the order note. Hardcoded 'crisis swap compensation' note removed from `action-executor.ts`. 4-unit per-variant cap recorded in the `exchanges` policy INTERNAL half.

**Known gaps / not yet shipped:**
- Phase 3 (⏳): over-cap refusal escalates a `dashboard_notifications` row (type='agent_approval_request', metadata.routed_to_function='ceo') carrying the ticket, customer, variant and requested quantity — same shape as the refused-raise escalation in `update_line_item_price`, per the CLAUDE.md north-star rule (hitting a rail escalates, does not execute).

**Recent activity:**
- Reason handling honest: tag = normalized slug (SDK-derived), note = caller's explanation. Measured 2026-08-02: 84 of 87 replacements were non-crisis yet every one carried the hardcoded 'crisis swap compensation' note, and 4 reasons exceeded Shopify's 40-char tag limit — one failed a real replacement outright.
- Per-variant cap enforced: `REPLACEMENT_MAX_UNITS_PER_VARIANT = 4` and `findVariantOverCap()` guard all callers. Cheap insurance rather than a live fire — exactly 1 of 87 replacements had ever exceeded it.
- Countrycode normalization tightened; unresolvable codes now fail loudly instead of silently.
- Multi-item support added to `createReplacementOrder`.
- Stalled replacement reconciliation integrated via [[replacement-stall]].

**Open questions:** None

---

[[../README]] · [[../../CLAUDE]]
