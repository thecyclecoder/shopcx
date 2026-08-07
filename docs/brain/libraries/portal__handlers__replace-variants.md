# libraries/portal/handlers/replace-variants

Portal swap variant on a sub line.

**File:** `src/lib/portal/handlers/replace-variants.ts`

## Exports

### `replaceVariants` — const

```ts
const replaceVariants: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

- **Price-guard refusals are routed BEFORE vendor errors.** When a swap would raise the realized price above what the pricing rules produce, [[subscription-items]] `subSwapVariant` (Appstle rail) and [[internal-subscription]] `internalSubSwapVariant` (internal rail) return a `priceGuardRefusal` object. The handler checks for this BEFORE routing to `handleAppstleError`, so an internal-contract refusal gets classified as a distinct 422 `price_guard_refusal` (not a 502 `appstle_error` mislabel). Ticket e2a55cfb (Isabel, 2026-08-05): her internal contract `internal-8922b5701b2f45ea` swap refusal was surfaced as an Appstle error even though Appstle was not involved; this early-exit fix prevents the mislabel. The portal renders the message via `describePriceGuardRefusal`, which explains the per-unit increase and attributes it to a forfeited discount when applicable. Spec: [[../specs/swap-price-guard-compares-against-the-pricing-rules-not-the-old-price]].
- **`oldLineId` is not a real Shopify line id for Appstle subs.** The portal sends
  `oldLineId = line.id`, and [[portal__helpers__transform-subscription]] sets
  `line.id = line_id || variant_id`. Appstle sub lines usually carry no Shopify
  `SubscriptionLine` id, so this is actually the **variant id** (or a catalog
  UUID). The old handler wrapped it as `gid://shopify/SubscriptionLine/<x>` and
  sent it as `oldLineId` → Appstle rejected the swap with **400** (the Jessica
  Ollet ticket `11746b62-…`). Fix: for Appstle subs, when `oldLineId` isn't
  already a `gid://shopify/SubscriptionLine/…` GID, the handler resolves it to
  the line's `variant_id` from `subscriptions.items` and sends the reliable
  **`oldVariants`** payload instead (same path `subSwapVariant` in
  [[subscription-items]] uses). It only falls back to the synthesized line GID
  when no variant id can be resolved.
- **Internal subs ignore the Appstle `body`.** They take the internal branch
  (decompose into `subSwapVariant`/`subAddItem`/… on `subscriptions.items`);
  `body.oldLineId`/`body.oldVariants` are only used for the Appstle fetch.
- **Suppressed-variant server gate.** Right after unpacking `newVariants` /
  `newOneTimeVariants`, the handler calls
  [[portal__mutation-guard]] `assertNewVariantsSelectable` and returns
  `variant_not_selectable` (400) if any target id sits in
  `workspaces.portal_config.suppressed_variant_ids`. Closes the crafted-request
  hole around the UI catalog filter — hiding-in-the-UI ([[portal__handlers__bootstrap]])
  is not the only bar. Only NEW selection is blocked; existing sub lines on a
  suppressed variant continue billing on renewal.

---

[[../README]] · [[../../CLAUDE]]
