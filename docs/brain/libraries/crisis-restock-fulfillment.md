# libraries/crisis-restock-fulfillment

`shipRestockPromises()` — on crisis resolve, ships every recorded "send it when it's back" restock promise for a customer with **no subscription**. Phase 2 of [[../specs/crisis-resolve-ships-promised-restock-replacements]].

**File:** `src/lib/crisis-restock-fulfillment.ts`

## Why

The crisis lifecycle restores **subscribers** on resolve (resume, re-add, swap-back), all keyed off a [[../tables/crisis_customer_actions]] row tied to a subscription. A one-time buyer who was promised the out-of-stock item at restock had nowhere to live — the promise sat in a snoozed ticket a human had to remember (ground truth: Peggy, customer `0897b4e5`). Phase 1 records the promise as an `awaiting_restock` [[../tables/replacements]] row (`promise_restock_replacement`, see [[action-executor]]); this module is the resolve-time fan-out that actually ships it.

## Exports

### `shipRestockPromises` — function

```ts
async function shipRestockPromises(
  admin, workspaceId, crisisId, deps?,
): Promise<{ created: […], failed: […] }>
```

Called from the resolve POST in `src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts` AFTER the crisis status flips to `resolved`. For every `awaiting_restock` [[../tables/replacements]] row scoped to this crisis + workspace:

1. **Compare-and-set** claims the row off `awaiting_restock` → `pending` (`update … .eq('status','awaiting_restock')`) BEFORE any Shopify call. Zero rows transitioned ⇒ a concurrent Resolve / double-click already owns it ⇒ skip. This is what makes a double-click idempotent.
2. Resolves the Shopify customer id across the link group ([[action-executor]] `resolveGroupShopifyCustomerId`) and the current shipping address ([[customer-shipping-address]] `resolveCustomerShippingAddress`).
3. Ships through [[replacement-order]] `createReplacementOrder` with **`existingReplacementId` = the promise row id**, so the SDK UPDATES the same row (`pending → created`/`failed`) rather than minting a second — one row per promise, record-first intact.
4. **Success:** internal ticket note `Crisis resolved: restock replacement {order name} created ({items}).`; the customer gets the normal Shopify order confirmation.
5. **Failure:** row `status='failed'`, ticket reopened (`status='open'`), and a high-severity [[../tables/dashboard_notifications]] `fulfillment_alert` (severity in `metadata`, since there is no `severity` column). A failure does **not** un-resolve the crisis.

The `deps` param (createReplacement / resolveShopifyCustomerId / resolveShippingAddress) defaults to the real effectors and is injected in tests so the selection + compare-and-set run without live Shopify.

### `normalizePromiseItems` — function

```ts
function normalizePromiseItems(items): Array<{ variantId; quantity; title }>
```

Maps a promise row's stored `items` JSONB into the SDK's `{ variantId, quantity, title }` shape — drops empty variant ids, defaults non-positive quantity to 1.

## Callers

- `src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts` — resolve POST, after the status flip.

## Gotchas

- **The caller owns the status flip; the SDK does not.** `createReplacementOrder`'s reuse path intentionally does NOT compare-and-set on status — this module does the `where status='awaiting_restock'` claim first, so the two-ship guard lives at exactly one place.
- **`dashboard_notifications` has no `severity` column** and `type` is CHECK-constrained. The alert uses `type='fulfillment_alert'` with `metadata.severity='high'`, and writes `body` (not `message`). See [[../tables/dashboard_notifications]] § type CHECK.
- **A restock failure never blocks the crisis resolve.** The crisis is already `resolved` when this runs; a failed promise surfaces as a reopened ticket + alert, not a 207.

## Related

[[../lifecycles/crisis-campaign]] · [[replacement-order]] · [[action-executor]] · [[../tables/replacements]] · [[../tables/crisis_events]] · [[../specs/crisis-resolve-ships-promised-restock-replacements]]
