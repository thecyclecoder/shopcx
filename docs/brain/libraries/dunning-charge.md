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
| `dunningChargeContract(ws, contractId, attemptOrdinal, cardKey?)` | one attempt, whichever engine bills it. `cardKey` (the card's `dedupeKey`) whenever one ordinal covers several cards — the payday pass |
| `dunningUnskip(ws, contractId, appstleAttemptId)` | unskips per engine; a no-op where the concept doesn't apply |
| `shopcxDunningIdempotencyKey(contractId, due, ordinal, cardKey?)` | pure — `${contract}:${cycleKey}:r${ordinal}[:${cardKey}]` |
| `shouldRefuseEarlyDunningCharge(due, inWindow, now?)` | pure — the paid-elsewhere guard below |
| `classifyPriorAttempt(read)` / `priorShopcxAttemptOutcome(ws, attemptId)` | `succeeded` / `unresolved` / `clear` for a cycle's last recorded Shopify attempt |

## ShopCX: the cycle is addressed BY INDEX

`resolveChargeableCycle` (first unbilled, non-skipped cycle) with its in-window `originTime` —
the renewal worker's and Order Now's shape. It addressed the cycle by `{ date: due }` with no origin
time until 2026-11-02, which failed whenever `due` landed in an already-BILLED cycle or Shopify
rejected the origin time: every rotation and payday attempt came back attempt-less, the cycle
exhausted, and cycle 2 cancelled a customer who could have paid. An unresolvable cycle returns no
attempt id, which dunning treats as "nothing charged", never as a decline.

⚠️ **By index can bill the NEXT order early.** Dunning holds our date in the past (or today), so a
date beyond today means another path already paid this cycle (an Order Now, a settled pending
attempt). When that is true AND the only unbilled cycle is a future one (`inWindow: false`),
`shouldRefuseEarlyDunningCharge` refuses — no attempt id, no card burned. A sub due later today, or
a resumed sub whose open cycle is still unbilled, still retries.

## ⚠️ The idempotency key is deliberately DIFFERENT from the renewal worker's

The worker uses `${contract}:${cycleKey}`. Dunning is retrying a cycle the worker already attempted,
so **reusing that key makes Shopify replay the cached FAILED attempt** rather than trying the card
again — a rotation onto a good card could never succeed. Dunning appends a retry counter
(`:r${n}`) so each attempt is distinct while still being idempotent within itself.

⭐ **The payday pass adds the card.** Every card in one payday pass shares `payday_retry_count`, so
the bare `:r${n}` key made card B replay card A's cached decline: only the first card was ever
presented and the ladder cancelled customers whose second card was good. The payday call passes
`card.dedupeKey`; a step retry for the same card still rebuilds the same key. Rotation gives each
card its own ordinal, so its key shape is unchanged.

## Gotchas

- **`pending` is not failure — and it stops the card loop.** A 3DS/CHALLENGED attempt (or a poll
  timeout) returns `pending: true`; the caller leaves the cycle open, records the attempt id on
  `dunning_cycles.billing_attempt_id`, and presents NO further card. Card rotation used to keep
  going: the next iteration switched to the same card with a new ordinal (a new key, a new real
  charge), so a slow success was charged twice. Before its next pass the payday cron reads that
  attempt (`priorShopcxAttemptOutcome`): settled as a charge → the cycle is `recovered` and no card
  is presented; still unresolved → no card this pass (the pass is counted, so the cap still bounds
  it); a decline → retry as normal.
- **ShopCX subs belong in the payday cron.** Its filter excludes `internal-%` only, and shopcx
  contract ids are numeric, so they are selected — correctly, now that the engine is resolved at
  charge time.
- The Appstle branch is unchanged, so nothing about the ~2,000 subs still on the vendor moves.

## Related

[[../lifecycles/dunning]] · [[commerce__subscription]] · [[commerce__shopify-subscription-client]] ·
[[../inngest/shopify-subscription-renewals]]
