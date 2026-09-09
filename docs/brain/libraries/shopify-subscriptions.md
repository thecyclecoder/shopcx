# `src/lib/shopify-subscriptions.ts`

ShopCX's own Shopify subscription client — the replacement for [[appstle]]. Mirrors `appstle.ts`'s
function signatures so swapping a caller is an import change, not a rewrite.

Design + migration plan: [[../lifecycles/shopcx-subscriptions]]. Dunning interaction: [[../lifecycles/dunning]].

## Two facts that drive the whole module

1. **Shopify fires nothing.** It stores `billingPolicy` and computes cycles, but never charges and
   never advances `nextBillingDate` — verified on a live contract. The scheduler stays ours.
2. **The contract IS the charge.** Shopify builds the renewal order from the contract, so every
   mutation must round-trip here. Anything living only in our mirror is cosmetic.

## Exports

| Export | Mirrors | Shape |
|---|---|---|
| `shopifySubscriptionAction(ws, contractId, 'pause'\|'cancel'\|'resume')` | `appstleSubscriptionAction` | direct |
| `shopifySetNextBillingDate(ws, contractId, date)` | `appstleUpdateNextBillingDate` | direct |
| `shopifyUpdateBillingInterval(ws, contractId, interval, count)` | `appstleUpdateBillingInterval` | draft |
| `shopifySkipBillingCycle(ws, contractId, cycleIndex?)` | `appstleSkipNextOrder` / `appstleSkipUpcomingOrder` | direct |
| `shopifyUnskipBillingCycle(ws, contractId, cycleIndex?)` | `appstleUnskipOrder` | direct |
| `shopifySwitchPaymentMethod(ws, contractId, pmId)` | `appstleSwitchPaymentMethod` | draft |
| `shopifyAddLine(ws, contractId, variantId, qty, price)` | `appstleAddFreeProduct` | draft |
| `shopifySwapProduct(ws, contractId, lineId, newVariantId)` | `appstleSwapProduct` | direct |
| `shopifyUpdateLineQuantity(ws, contractId, lineId, qty, alsoInDraft?)` | — | draft |
| `shopifyAttemptBilling(ws, contractId, idempotencyKey, opts?)` | `appstleAttemptBilling` / `orderNowByContract` | direct |
| `getBillingAttempt` / `awaitBillingAttempt` | — | read |
| `getSubscriptionContract(ws, contractId)` | — | read |
| `getUpcomingBillingCycles(ws, contractId, opts?)` | `appstleGetUpcomingOrders` | read |
| `withDraft(ws, contractId, mutate)` | — | envelope |
| `contractGid` / `asFailure` | — | helpers |

All action functions return `{ success, error? }` — the same flat shape as `appstle.ts`, which is
what makes the swap mechanical.

## `withDraft` — batch related edits into ONE commit

Draft-based edits share one envelope: `subscriptionContractUpdate` → mutate → `subscriptionDraftCommit`.
A failure inside `mutate` returns BEFORE commit, so the contract is untouched; the draft is simply
abandoned (there is no discard mutation and none is needed).

**Batch related edits.** A quantity change and its quantity-break discount must commit together —
`shopifyUpdateLineQuantity`'s `alsoInDraft` callback exists for exactly this. Split across two
commits, a charge landing in the window bills the new quantity at the old tier.

## Signature mismatches vs Appstle (deliberate)

- `appstleAttemptBilling` / `appstleUnskipOrder` take Appstle **billing-attempt** ids. Shopify
  addresses a **contract** (+ optional cycle selector). The routing layer must not pass an attempt id.
- `appstleSwapProduct` took the old variant id; `shopifySwapProduct` takes the **line id** — a
  contract can carry the same variant on two lines. Resolve it via `getSubscriptionContract` first.
- `shopifySkipBillingCycle` is a REAL per-cycle skip. Today's implementation shoves
  `next_billing_date` forward, conflating "skip this one" with "change my date".

## Gotchas

- **⚠️ `nextBillingDate` and the cycle schedule are independent.** `subscriptionBillingCycles`
  computes cycles from the contract's origin anchor; `nextBillingDate` is a separately-stored,
  manually-settable field. Observed live on contract `35917070509`: `nextBillingDate` = 2027-01-15
  while the next UNBILLED cycle was 2026-11-03. The renewal worker must pick ONE as authoritative
  (we use `nextBillingDate`, since we own the schedule) and not assume they agree.
- **Introspection is scope-filtered — probe by CALLING.** The draft mutations and
  `SubscriptionBillingAttempt`'s `ready` / `errorCode` / `errorMessage` / `order` fields do NOT
  appear in `__type` results but execute fine. Never conclude "field doesn't exist" from introspection.
- **`SubscriptionLine` has BOTH `variantId` and `productId`** and they are not interchangeable.
  Selecting the wrong one silently yields ids that fail every variant-keyed lookup.
- **App-ownership scoping.** `read_own_subscription_contracts` means this client sees only contracts
  OUR app created. Appstle's contracts are invisible here — which is also why we get no webhooks for
  them. This is the whole reason migration is a per-contract recreate, not a flag flip.
- **`shopifyAttemptBilling` returns on ACCEPTANCE (~550ms), not on the charge.** Poll with
  `awaitBillingAttempt` for the common case; the `subscription_billing_attempts/*` webhooks
  ([[shopify-billing-attempt-webhook]]) are the backstop for CHALLENGED (3DS) and anything outliving
  the function. `awaitBillingAttempt` is bounded (30s default) so a 3DS attempt can't hold a step open.
- **Pass a real `idempotencyKey`** — the renewal cycle key. It is Shopify's own double-charge guard.
- Uses the pinned `SHOPIFY_API_VERSION` (2025-07). Verified: the full subscription surface exists
  there, so no version bump is needed.

## Status

Client only. **No caller is wired yet** — the `billing_source` routing layer is the next step, and
until it lands every mutation still goes through [[appstle]].
