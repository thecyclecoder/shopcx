# libraries/customer-shipping-address

**Status:** Shared current-address resolver for all order-creating actions. Ensures replacements, new orders, and other shipment destinations respect the customer's current canonical address, not stale cited-order snapshots.

**Incident:** Ticket 49ddd6c4 (Catherine Green) — replacement shipped to stale Rochester MN address from an old order, despite both `customers.default_address` and the subscription recording Kirkland WA as the current, correct address. The resolver surfaces this divergence and prevents it recurring.

**File:** `src/lib/customer-shipping-address.ts`

## Exports

### `resolveCustomerShippingAddress(admin, workspaceId, customerId, opts)` — function

```ts
async function resolveCustomerShippingAddress(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  opts: ResolveOptions = {}
): Promise<ResolvedShippingAddress | null>
```

Resolves the authoritative shipping address for an order-creating action. Reads candidates from four sources and picks in priority order: (1) `addressOverride` (operator forcing a one-off destination), (2) `customers.default_address` (canonical current address), (3) active subscription `shipping_address`, (4) cited order's `shipping_address` (last-resort snapshot), (5) most-recent order (deep safety net). Returns `null` only when NO source yielded an address.

Also detects **divergence**: when the cited order's address differs from the canonical current address chosen, it flags `diverged: true` so the caller can log an internal note (customer moved; shipping to current address).

**Priority chain invariant:** override > default_address > subscription > cited_order > recent_order. The first four are read from the DB; the fifth only queries if the first four all fail.

### `pickCanonicalShippingAddress(sources)` — function

```ts
function pickCanonicalShippingAddress(sources: ResolverSources): ResolvedShippingAddress | null
```

Pure address-picker — no DB access. Applied to normalized address inputs from each source; returns the chosen address + source label + divergence flag. Extracted so the priority logic can be tested without a Supabase mock.

### `normalizeAddress(raw)` — function

```ts
function normalizeAddress(raw: RawShippingAddress): NormalizedShippingAddress | null
```

Coerces whatever field shape a source gave us (Shopify uses `province`/`country`, internal writes use `province_code`/`country_code`, Sonnet overrides use camelCase) into the canonical camelCase shape. Returns `null` if the input is missing `address1` (core required field). `countryCode` is routed through `normalizeCountryToIso2` (`src/lib/country-iso2.ts`) and `provinceCode` through `normalizeProvinceToCode` (`src/lib/province-usps.ts`) so full-name inputs resolve to the correct 2-letter code instead of a naive 2-char slice.

### `sameShippingAddress(a, b)` — function

```ts
function sameShippingAddress(a: NormalizedShippingAddress, b: NormalizedShippingAddress): boolean
```

Semantic address comparison — two addresses agree when `address1 + zip` match case-insensitively. Deliberately ignores firstName/lastName (renames aren't moves) and province (fully-typed address1 already localizes the city). Used to detect divergence.

### `formatDivergenceNote(resolved, orderNumber?)` — function

```ts
function formatDivergenceNote(resolved: ResolvedShippingAddress, orderNumber?: string | null): string
```

Human-readable divergence line for the internal system note. Example: `"[Address divergence] order 12345 ships to 123 Main St, Rochester MN 55901, but customer's current account address is 456 Oak Ave, Kirkland WA 98033 — customer moved; shipping to current address."` The signal the system had but ignored on 49ddd6c4.

### Types

- `NormalizedShippingAddress` — canonical camelCase shape: `{ firstName, lastName, phone, address1, address2, city, province, provinceCode, zip, countryCode }`
- `ResolvedShippingAddress` — `{ address: NormalizedShippingAddress, source: AddressSource, diverged: boolean, citedOrderAddress: NormalizedShippingAddress | null }`
- `AddressSource` — enum: `"override" | "default_address" | "subscription" | "cited_order" | "recent_order"`
- `RawShippingAddress` — permissive input type accepting any blend of Shopify (`province`, `country`), internal (`province_code`, `country_code`), and camelCase (`firstName`, `address1`, etc.) fields

## Callers

- `src/lib/action-executor.ts` — `create_replacement_order`, `create_order`, and commerce order-creating actions route through it
- `src/lib/replacement-order.ts` — `createReplacementOrder` uses it
- `src/lib/customer-shipping-address.audit.test.ts` — audit test verifies every order-creating handler delegates to the resolver

## Gotchas

- **`default_address` is the canonical current address.** It is written by `update_shipping_address` and is the source-of-truth when a customer updates their address on file. Subscription `shipping_address` is a fallback; customers who subscribe but never update their account address fall back to it. The cited order's `shipping_address` is a last-resort snapshot that the resolver reads only when the canonical current sources are empty.

- **Divergence is logged, not silent.** When the resolver picks a canonical current address and the cited order says something different, it sets `diverged: true` and the caller passes the note from `formatDivergenceNote()` to the internal sysNote. This surfaces moves the system noticed but could have ignored (ticket 49ddd6c4 regression pin).

- **Address override still wins.** An operator can force a one-off destination by passing `addressOverride` — it sits at the top of the priority chain so a customer-service representative can ship to a corrected address without waiting for the customer to update their account.

- **Most-recent order is the deep safety net.** If a customer has no default_address, no subscription with an address, and the cited order yields nothing, the resolver queries the most-recent order on file. This ensures we never fail with "no address" when a customer with old orders is requesting a replacement — even if they have zero current address on file, we can still ship somewhere.

- **Audit test prevents regressions.** `src/lib/customer-shipping-address.audit.test.ts` verifies every order-creating action in `directActionHandlers` imports and calls `resolveCustomerShippingAddress` — no inline address-picking, no reads of `orders.shipping_address` to set a destination without going through the resolver. Any new order-creating action must pass this audit.

- **`provinceCode` is normalized, never sliced** (ticket 84a8104a). A full-name province is resolved to its 2-letter USPS/ISO 3166-2 code via `normalizeProvinceToCode` (`src/lib/province-usps.ts`), the province twin of `normalizeCountryToIso2`. The old `province.toUpperCase().slice(0,2)` produced valid-but-WRONG codes on prefix collisions — `Nevada`→`NE` (Nebraska), `Montana`→`MO` (Missouri), `Alaska`→`AL` (Alabama), `Massachusetts`→`MA` (coincidentally correct, but `Maryland`/`Maine`/`Minnesota`/`Michigan`/`Mississippi`/`Missouri` all collide on `M`). A wrong-but-valid code fails Shopify delivery-method zip validation (`Delivery method shipping address zip is invalid`) and wedged Chanen Cross's portal reactivate (contract 28153413805) until a human re-wrote the province as `NV`. The helper maps US states + territories + CA provinces, passes through already-valid 2-letter codes, and **leaves an unknown / non-US-CA value unsliced** rather than emitting a wrong 2-char guess. Collision cases are pinned in `customer-shipping-address.test.ts`.

## Address normalization table

| Source | firstName | lastName | phone | address1 | address2 | city | province/state | zip | country/countryCode |
|---|---|---|---|---|---|---|---|---|---|
| Shopify order | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `province` | `zip` | `country` |
| customers.default_address | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `province_code` | `postal_code` | `country_code` |
| subscriptions.shipping_address | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `province_code` | `postal_code` | `country_code` |
| Sonnet override (camelCase) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `province` \| `provinceCode` | ✓ | `country` \| `countryCode` |

`normalizeAddress` collapses all variants to canonical camelCase; `sameShippingAddress` compares semantically by address1 + zip.

---

[[../README]] · [[../../CLAUDE]]
