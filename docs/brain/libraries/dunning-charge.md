# `src/lib/dunning-charge.ts`

Engine-aware charging for [[../lifecycles/dunning]]. The one charge path that `billing_source`
routing could NOT be pushed into [[commerce__subscription]].

## Why it exists

Appstle's retry flow is `getUpcomingOrders → attemptBilling(ATTEMPT id)`. By the time control
reaches any dispatch point the contract id has already been traded for an attempt id — and a
ShopCX-owned Shopify contract has **no Appstle attempts at all**.

Left unrouted, a migrated subscription that declined would:
1. look up upcoming orders that do not exist,
2. read every card as failed,
3. burn `MAX_PAYDAY_RETRIES`,
4. hit the cycle-2 ladder — which **CANCELS the subscription**.

A customer with a perfectly good card, cancelled by a retry loop that never charged anything.

## Exports

| export | notes |
|---|---|
| `dunningChargeContract(ws, contractId)` | one attempt, whichever engine bills it |
| `dunningUnskip(ws, contractId, appstleAttemptId)` | unskips per engine; a no-op where the concept doesn't apply |

## ⚠️ The idempotency key is deliberately DIFFERENT from the renewal worker's

The worker uses `${contract}:${cycleKey}`. Dunning is retrying a cycle the worker already attempted,
so **reusing that key makes Shopify replay the cached FAILED attempt** rather than trying the card
again — a rotation onto a good card could never succeed. Dunning appends a retry counter
(`:r${n}`) so each attempt is distinct while still being idempotent within itself.

## Gotchas

- **`pending` is not failure.** A 3DS/CHALLENGED attempt returns `pending: true`; the caller must
  leave the cycle open rather than counting a decline. Dunning a customer who is mid-3DS is worse
  than being slow.
- **ShopCX subs belong in the payday cron.** Its filter excludes `internal-%` only, and shopcx
  contract ids are numeric, so they are selected — correctly, now that the engine is resolved at
  charge time.
- The Appstle branch is unchanged, so nothing about the ~2,000 subs still on the vendor moves.

## Related

[[../lifecycles/dunning]] · [[commerce__subscription]] · [[commerce__shopify-subscription-client]] ·
[[../inngest/shopify-subscription-renewals]]
