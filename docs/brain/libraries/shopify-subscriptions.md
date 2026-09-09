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
| `shopifyAddLine(ws, contractId, variantId, qty, price)` | 🚨 **NOT** `appstleAddFreeProduct` — see below | draft |
| `shopifySwapProduct(ws, contractId, lineId, newVariantId)` | `appstleSwapProduct` | direct |
| `shopifyUpdateLineQuantity(ws, contractId, lineId, qty, alsoInDraft?)` | — | draft |
| `shopifyAttemptBilling(ws, contractId, idempotencyKey, opts?)` | `appstleAttemptBilling` / `orderNowByContract` | direct |
| `getBillingAttempt` / `awaitBillingAttempt` | — | read |
| `getSubscriptionContract(ws, contractId)` | — | read |
| `getUpcomingBillingCycles(ws, contractId, opts?)` | `appstleGetUpcomingOrders` | read |
| `withDraft(ws, contractId, mutate)` | — | envelope |
| `contractGid` / `asFailure` | — | helpers |

All action functions return `{ success, error? }` and never throw (`gql` converts credential,
network and non-JSON faults into that shape).

## ⚠️ What this module deliberately does NOT do — the swap is NOT mechanical

An earlier draft of this page claimed "swapping a caller is an import change, not a rewrite."
**That is wrong and dangerous.** `appstleSubscriptionAction` is a vendor call wrapped in six side
effects that live in `appstle.ts`, not in the SDK router:

| `appstle.ts` also does | why it matters |
|---|---|
| `isInternalSubscription` → `internalSubscriptionAction` | internal Braintree subs must not go to Shopify |
| `resolveContractIdForAppstle` (UUID → contract id) | callers really do pass `subscriptions.id` UUIDs |
| `healOnTouch` | mirror repair |
| writes `subscriptions.status` | our own source of truth |
| `applyCancelTruth` (nulls `next_billing_date`, stamps `cancelled_at`) | the cancel-truth invariant |
| `endDunningForSubscription` on pause/cancel | CEO rule: a pause/cancel ENDS dunning |
| `customers.subscription_status` rollup | dashboard + segmentation |

An import-only swap at e.g. `portal/handlers/cancel.ts` would cancel the Shopify contract and
leave the row `status='active'` with a future `next_billing_date` **and a dunning cycle still
retrying a cancelled sub** — exactly the incident `applyCancelTruth` and
`endDunningForSubscription` were written to retire. Those seven behaviors are the **routing
layer's** job. This module is a thin vendor client and nothing more.

### Missing counterparts — Appstle cannot be deleted on this module alone

`appstleSendPaymentUpdateEmail` (no Shopify equivalent — needs our own Resend flow),
`orderNowByContract` (has an internal branch + `summary`/`internal` shape), line **removal**
(`subscriptionDraftLineRemove`), **discounts** (`subscriptionDraftDiscount{Add,Update,Remove}` —
load-bearing for every cancel-flow coupon remedy), free shipping, and line-price override.

### 🔴 Silent-swap hazard: attempt id vs contract id

`appstleAttemptBilling` / `appstleUnskipOrder` take an Appstle **billing-attempt id**;
`shopifyAttemptBilling` / `shopifyUnskipBillingCycle` take a **contract id**. Both are `string`,
so a wrong swap **compiles clean**. At-risk sites: `inngest/dunning.ts` (4 charge paths + the
`cycle.billing_attempt_id` unskip), `portal/handlers/order-now.ts`, and
`commerce/subscription.ts`'s `subscriptionAttemptBilling` / `subscriptionUnskipOrder`, whose own
parameters are named `billingAttemptId`.

It fails safe (not-found → `{success:false}`) but it fails **silently as a stopped charge**, which
is the loss class this codebase keeps getting bitten by. Note also that the four dunning paths are
`getUpcomingOrders → attemptBilling` **pairs**; under Shopify there is no attempt-id lookup step
at all, so those sites need **restructuring, not routing** — a `billing_source` switch inside
`subscriptionAttemptBilling` cannot fix them, because the contract id has already been discarded
by the time control reaches it.

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
- `shopifySkipBillingCycle` is a real per-cycle skip **in Shopify** — but whether it moves OUR
  scheduler is unresolved. `appstleSkipNextOrder` skipped by advancing `next_billing_date`, which
  is what our cron actually fires on; this marks the Shopify *cycle* skipped and touches neither
  `nextBillingDate` nor our mirror. Until the renewal worker reconciles the two calendars, a
  caller swapping to it could tell the customer their order is skipped and still charge them.

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
- **`shopifyAttemptBilling` returns on ACCEPTANCE (~550ms), not on the charge.** The result now
  carries `accepted` / `terminal` / `pending` — **`success` is only meaningful once `terminal` is
  true.** `awaitBillingAttempt` is bounded (30s) and returns `{success:false, pending:true,
  timedOut:true}` rather than reporting an unsettled charge as collected.
  ⚠️ **There is no webhook backstop yet.** [[shopify-billing-attempt-webhook]] is explicitly
  RECORDS-ONLY and does not drive dunning. Until it does, a CHALLENGED (3DS) attempt that outlives
  the poll is genuinely unresolved — the renewal worker must leave the cycle open, not guess.
- **Pass a real `idempotencyKey`** — the renewal cycle key. It is Shopify's own double-charge guard.
- Uses the pinned `SHOPIFY_API_VERSION` (2025-07). Verified: the full subscription surface exists
  there, so no version bump is needed.

- **An empty billing-cycle selector is ILLEGAL** — Shopify enforces "requires exactly one of
  index, date", and indices are **1-based**. There is no "just do the next one" mode, and
  `date: now` resolves to the CURRENT (usually already-BILLED) cycle. `resolveCycleSelector` reads
  the schedule and picks the first `UNBILLED` cycle instead.
- **Omitting `billingCycleSelector` on a charge bills Shopify's CURRENT calendar cycle**, not the
  renewal we decided to fire. On the live contract that cycle was already `BILLED`. Pass a
  selector once the worker knows which cycle it is charging.
- **The billing/delivery policies are WHOLE-OBJECT replacements.** Sending only
  `{interval, intervalCount}` wipes `anchors` / `minCycles` / `maxCycles`, silently moving every
  future charge date on an anchored contract. `shopifyUpdateBillingInterval` read-modify-writes.
- **Interval is force-uppercased and validated** — `action-executor.ts` force-casts a raw
  LLM-produced string into that position (ticket 5e7c1c80).
- **Date-only inputs anchor at NOON UTC**, matching `appstle.ts`. Midnight-UTC floored "Oct 2"
  back to Oct 1 in US zones (ticket 83ee7005); noon is the same calendar day across UTC-10..UTC-4.
- `lines(first:50)` selects `pageInfo.hasNextPage`; a >50-line contract is truncated.
- **No throttle/backoff yet.** `shopify-draft-orders.ts` already has the right primitive
  (`isThrottleError` + exponential backoff over 429/5xx, THROTTLED arrives as an HTTP **200**).
  Reuse it before the renewal worker runs this at thousands-of-contracts scale.

## Status

Client only. **No caller is wired yet** — the `billing_source` routing layer is the next step, and
until it lands every mutation still goes through [[appstle]].
