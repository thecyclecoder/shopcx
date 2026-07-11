# libraries/portal/mutation-guard

Two independent guards every portal subscription mutation runs through — the
first-delivery anti-gaming gate (blocks EVERY mutation until the first order
is delivered) and the suppressed-variant gate (blocks NEW selection of a
variant we've pulled off the portal — crisis availability lever).

**File:** `src/lib/portal/mutation-guard.ts`

## Exports

### `MUTATION_GATED_ROUTES` — `Set<string>`

Every portal route the dispatcher runs `canMutateSubscription` on before
handing off to the handler. Lowercased (matches the dispatcher's cased route
key). See `src/app/api/portal/route.ts` for the wire-up.

### `canMutateSubscription(workspaceId, sub)` — first-delivery gate

Async — reads the sub's earliest 1–2 orders and returns
`{ allowed, reason?, state? }`. Fails OPEN (allows) on an EasyPost hiccup.
Delegates the pure branch decision to `decideMutationGate`.

### `decideMutationGate(first, orderCount, now)` — pure predicate

Three branches:

1. **Renewal short-circuit** — `orderCount > 1` ⇒ allow (a second order proves
   the first billing cycle completed).
2. **Internal order** (`shopify_order_id == null`) — tracking + EasyPost, or a
   fulfilled-plus-7-day grace fallback.
3. **Shopify order** — `fulfillment_status` in the allowed set ⇒ allow.

### `findSuppressedNewVariants(variantIds, suppressed)` — pure predicate

Returns the variant IDs from the caller's payload that appear in the
workspace's "not selectable for new choice" set. Strips
`gid://shopify/ProductVariant/…` prefixes so a crafted request in either shape
is caught. Empty suppressed set = fast-path allow.

### `getSuppressedVariantIds(workspaceId)` → `Promise<Set<string>>`

Reads `workspaces.portal_config.suppressed_variant_ids` (JSONB array of
Shopify variant id strings) and normalises it to a Set of bare numeric ids.
Consumed by [[portal__handlers__bootstrap]] (catalog filter) and
[[portal__handlers__replace-variants]] (server-side rejection).

### `assertNewVariantsSelectable(workspaceId, variantIds)`

Async wrapper — fetches the suppressed set and applies the pure predicate,
returning `{ ok: true }` or `{ ok: false, blocked }`. `replaceVariants` calls
this right after unpacking `newVariants` / `newOneTimeVariants` and returns
`variant_not_selectable` (400) on `{ ok: false }`.

## Design

A suppressed variant is IN STOCK but must not be selectable via any portal
new-choice path (swap / add-line / change-flavor). The `inventory_quantity > 0`
UI filter can't hide it, and Shopify admin variant deactivation would break
renewals billed against that variant — so we keep the block VISUAL-and-server
in ShopCX and leave the Shopify variant active.

**Two-layer defence:**

1. [[portal__handlers__bootstrap]] drops suppressed variants from the swap/add
   catalog it returns to the portal UI, so the UI never OFFERS them.
2. [[portal__handlers__replace-variants]] calls `assertNewVariantsSelectable`
   right after unpacking `newVariants` / `newOneTimeVariants`, so a crafted
   request that names a suppressed variant directly is rejected with a stable
   4xx — the UI hide isn't the only bar.

`variant_not_selectable` is listed in the dispatcher's `VALIDATION_ERRORS`
set (see [[portal__route]]) so a legitimate hit does NOT spawn a
`portal-action-failed` ticket.

**Hard invariant:** the guard screens NEW selection only. It never runs against
`contract.lines` — existing subscription lines already on a suppressed variant
keep billing on renewal without interruption.

## Config source

```
workspaces.portal_config: {
  suppressed_variant_ids: string[]  // Shopify variant IDs, no GID prefix
}
```

Seeded via a one-off script (e.g. `scripts/seed-suppress-strawberry-lemonade.ts`).
Merges with any existing entry rather than replacing.

## Callers

- `src/app/api/portal/route.ts` — first-delivery gate + validation-error set.
- `src/lib/portal/handlers/bootstrap.ts` — `getSuppressedVariantIds` (catalog filter).
- `src/lib/portal/handlers/replace-variants.ts` — `assertNewVariantsSelectable`.

## Tests

- `src/lib/portal/mutation-guard.test.ts` — first-delivery branch table.
- `src/lib/portal/suppressed-variants.test.ts` — the SL/Peach Mango failing state.

## Gotchas

- **Never filter subscription LINES with `getSuppressedVariantIds`.** The set is
  a NEW-choice gate. Existing renewers on that variant keep billing — that's the
  whole point of picking a visual/server suppression instead of a Shopify
  variant deactivation.
- **Both shapes reach the guard.** `replaceVariants` normalises `newVariants`
  through `asQtyMap` (which strips GIDs) before the guard call, and
  `findSuppressedNewVariants` re-strips defensively so a raw
  `gid://shopify/ProductVariant/<id>` never sneaks past.

---

[[../README]] · [[../../CLAUDE]]
