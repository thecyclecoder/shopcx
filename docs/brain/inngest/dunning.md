# inngest/dunning

Dunning orchestrator: payment-failed → card rotation → payday retries → cycle action. Plus new-card-recovery + billing-success cleanup. Writes `dunning_cycles`, `payment_failures`. See Phase 5 in CLAUDE.md.

**File:** `src/lib/inngest/dunning.ts`

## Functions

### `dunning-payment-failed`
- **Trigger:** event `dunning/payment-failed`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]`
- **Card rotation stops on an unresolved (pending) attempt.** The rotation step returns `"pending"`,
  records the attempt id on the cycle (`billing_attempt_id`) and the loop breaks — exactly as the
  payday pass does. It used to rotate on: the next iteration switched to the same card (pending is
  not added to `cards_tried`) with a new ordinal, i.e. a new Shopify key and a new real charge, so a
  slow success was charged twice. See [[../libraries/dunning-charge]].


### `dunning-new-card-recovery`
- **Trigger:** event `dunning/new-card-recovery`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }, { limit: 1, key: "event.data.customer_id" }]` — the per-customer cap is the idempotency invariant: two `dunning/new-card-recovery` events for the SAME customer (two rapid card updates, portal payment-method-update racing a webhook) serialize instead of both driving a recovery charge. The workspace cap (limit 3) stays as the tenant-noise ceiling. Phase 1 of [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]] — two concurrent runs on one customer produced the 4.2-min-apart double-charge on internal sub fd857ad9 (SHOPCX273 + SHOPCX274 both $102.33 on 2026-08-28); the [[../tables/subscription_cycle_charges]] unique index is the belt, this concurrency scope is the suspenders.
- **⚠️ Stale pre-migration contract id gotcha + billing-date advance (both recovery paths).** Every exhausted dunning cycle carries the `shopify_contract_id` it was CREATED with, which for a migrated customer is the **pre-migration** contract (ground truth: old `27900379309` → live contract `58099171501`). `subscriptionAction` / `subscriptionSwitchPaymentMethod` / `dunningChargeContract` resolve that internally, but the LOCAL writes do NOT — the `subscriptions` status select/update and the `subscriptions` update + Shopify date push inside `resetBillingDateAfterDunning` key on the id literally, so a stale id matches **zero rows** and silently no-ops. So BOTH per-contract steps (Step 2a reactivate-cancelled-subs, Step 2b recover-active-cycle) first compute `const liveContractId = await resolveLiveContractId(workspace_id, <cycle contract id>)` ([[../libraries/internal-subscription]]) and use `liveContractId` for every subsequent call and write. Separately, Step 2a used to charge the recovered sub but **never** call `resetBillingDateAfterDunning` at all, leaving `next_billing_date` in the past; the ShopCX renewal cron then re-billed the SAME period the next day. Fix: after `billingRes.success` on the 2a path, call `resetBillingDateAfterDunning(workspace_id, liveContractId, <exhausted cycle id>, true)` (the cycle id is now selected in Step 1b). Ground truth 2026-11-10: customer e04ce897 added a card at 03:31 UTC, recovery charged sub 8270e410 (cycle 21eb1cef, old contract `27900379309`) as SC142003, next_billing_date stayed 2026-11-11, and the renewal cron double-charged SC142110 ($69.46, cycle_key 2026-11-11), refunded by the founder 2026-11-12. Pinned by `src/lib/inngest/dunning.new-card-recovery-date.test.ts` (`npm run test:dunning-new-card-recovery-date`).


### `dunning-billing-success`
- **Trigger:** event `dunning/billing-success`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspace_id" }]`


### `dunning-payday-retry-cron`
- **Trigger:** cron `0 * * * *`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

**Filters internal cycles (Braintree-billed subs).** The find-retryable-cycles query excludes `.not('shopify_contract_id', 'ilike', 'internal-%')` so the Appstle payday cron never selects internal-contract rows. Internal subs don't go through Appstle card rotation — their renewal failures route to `handleInternalDunningFailure` (internal-dunning.ts), which reschedules `next_billing_date` to the next payday and marks the cycle `retrying`. The DAILY `internalSubscriptionRenewalCron` then re-charges Braintree on that payday (internal-subscription-renewals.ts:31-90), providing up to MAX_PAYDAY_RETRIES=4 retries. Skipping internal cycles in the Appstle cron removes noise (Appstle 400s on synthetic `internal-*` billing-attempt ids) without changing any billing outcome — see [[../specs/archive.d/internal-sub-write-path-gaps]] (Phase 3) and [[../specs/archive.d/dunning-payday-retry-skip-internal-subs]].

**ShopCX payday passes (2026-11-02).** Each card is charged with its own idempotency key
(`card.dedupeKey` appended — one ordinal covers the whole pass, so a shared key made Shopify replay
card A's decline for card B and backup cards were never presented). Before any card, the pass reads
the cycle's last recorded Shopify attempt (`priorShopcxAttemptOutcome`): settled as a charge → the
cycle is marked `recovered` and no card is presented; still unresolved → no card this pass; a
decline → normal retry. An unresolved payday attempt records its id on the cycle too.

**Control Tower heartbeat fires on every tick, including empty ones.** The `if (cycles.length === 0)` early-return (no `dunning_cycles` in `status='retrying'` with `next_retry_at <= now()`) emits its own `emitCronHeartbeat("dunning-payday-retry-cron", { produced: { status: "no_cycles_to_retry", processed: 0, results: [] } })` before returning, so a healthy hourly cron in a quiet dunning period reads green instead of tripping [[../libraries/control-tower]] monitor `never_fired`. The beat means "Inngest invoked me", not "there was work" — same fix as [[deliver-pending-send]], [[ticket-csat]], and [[abandoned-cart]] ([[../specs/cron-heartbeat-on-idle-tick]]).


## Downstream events sent

_None._

## Tables written

- [[../tables/dashboard_notifications]]
- [[../tables/subscriptions]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/dunning_cycles]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
