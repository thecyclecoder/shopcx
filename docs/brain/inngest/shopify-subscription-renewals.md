# `src/lib/inngest/shopify-subscription-renewals.ts`

Renewals for subscriptions our **Shopify app** bills — `subscriptions.billing_source = 'shopcx'`.
The counterpart to [[internal-subscription-renewals]] (Braintree) and the thing that replaces
Appstle's scheduler.

Design: [[../lifecycles/shopcx-subscriptions]] · client: [[../libraries/commerce__shopify-subscription-client]]

## ⭐ Why this exists

**Shopify fires nothing.** Verified on a live contract: it stores a `billingPolicy`, computes a
cycle calendar, and never charges or advances `nextBillingDate` on its own. So this cron *is* the
revenue for migrated subs. If it stops, they don't bill — **not late, never**, and silently.

That asymmetry is why the migration cannot run ahead of this worker: cancelling an Appstle contract
before this exists converts a paying subscription into a dead one with nothing to notice.

## Much smaller than the internal worker

A successful Shopify billing attempt **creates the order itself**, applies tax, and flows into the
existing order-webhook → Amplifier path. So there is no order creation, no Avalara call, no
Amplifier hand-off here. This worker only decides *when* to charge and handles the outcome.

## Two calendars — and which one decides

`subscriptions.next_billing_date` (ours) and Shopify's computed cycle schedule are **independent**.
Observed on contract 35917070509: our field said `2027-01-15` while Shopify's next unbilled cycle
was `2026-11-03`, with nothing reconciling them. And `next_billing_date` is a plain column — one
stray write mutes a subscription until whatever date it names (that is exactly how it got to
2027-01-15: a test write).

So:

| step | authority |
|---|---|
| pick CANDIDATES | ours (`next_billing_date <= end of today`) — cheap, O(due) |
| decide what is DUE | **Shopify** — the cycle CONTAINING our date (`selector: { date }`), which must be `UNBILLED` and unskipped |
| charge | Shopify, targeting that cycle index explicitly |
| advance | **the customer's own cadence from the date they were DUE** — never Shopify's cycle calendar |

A wrong local date therefore makes a charge **late** (which the migration audit catches) but never
**wrong**.

### ⭐ Why NOT "the earliest past-due cycle"

That was the original design and it is **wrong for migrated contracts** — the population this
worker exists for. Shopify anchors a contract's cycle calendar to its **`createdAt`**, not to the
`nextBillingDate` we set, so a contract created by the migration is born up to a full interval out
of step with the customer's real schedule. Measured on 35945087149:

```
our next_billing_date       2026-10-15   (35d out)
Shopify cycle #1 expected   2026-11-05   (56d out)
past-due hunt finds:        NOTHING DUE
```

A customer migrated today and due to renew tomorrow would simply never be charged. Resolving the
cycle by DATE (`selector: { date: next_billing_date }`) returns the containing cycle regardless of
where the calendar was anchored, and its `status` doubles as Shopify's own idempotency signal —
`BILLED` means that cycle already charged, whoever did it.

## ⭐ Advancing: cadence, not calendar

`billingAttemptExpectedDate` is the cycle **END**, so advancing to the next cycle's expected date is
only correct if the charge happened AT the previous cycle's end. A migrated contract's calendar is
re-anchored to its `createdAt`, so its first charge lands early inside cycle 1 and the next cycle's
end is most of an extra interval away.

Measured on 35945087149 — the first real end-to-end renewal:

```
charged      2026-09-11   (cycle 1 runs 09-10 → 11-05)
cycle-end advance → 2026-12-31    111 days on a 56-day cadence
cadence advance   → 2026-11-06    +56 days ✅
```

That is ~**one whole billing interval deferred, per migrated subscription** — invisible in a
per-cycle revenue figure, because it changes *when* cycles land rather than what they cost.

Two details that matter:
- **Anchor to `dueDate`, not to `now`.** A late charge (dunning recovery, a retried run) must not
  permanently drag the customer's rhythm forward; rolling by whole intervals from the scheduled date
  keeps them on their original days.
- **We are free to ignore Shopify's boundaries** because cycles are resolved BY DATE — the selector
  finds whichever cycle contains whatever date we set. Migrated subs renew on scattered days, and
  carrying each customer's real date across is the entire point.

## Flow

**`shopifySubscriptionRenewalCron`** — daily `0 10 * * *` (an hour after the internal cron):
kill-switch gate → keyset-paginated candidate select → dunning retry-window filter → fan out one
event per sub → heartbeat carrying `{ due }`.

**`shopifySubscriptionRenewalAttempt`** — per sub, concurrency 8:
kill-switch → stale guard → resolve the due cycle from Shopify → **claim the cycle** → charge →
settle → advance / dun.

## Gotchas

- **Keyset-paginate, always.** A bare select caps at the PostgREST 1000-row max and the overflow
  is dropped silently — and a dropped candidate here is a renewal that never happens.
- **The stale guard is not optional.** `expected_next_billing_date` is stamped on the fan-out
  event and re-checked live; if it moved, another attempt already took this cycle and charging
  again would double-bill *and* reopen dunning.
- **Claim before charging.** `claimCycleCharge` on `(subscription_id, cycle_key)` is our guard;
  Shopify's `idempotencyKey` is the second. An Inngest step retry is only safe because of both.
- **Always pass `billingCycleSelector`.** Omitting it bills Shopify's *current* calendar cycle,
  which after a migration re-anchor is usually not the one intended.
- **A pending attempt is neither success nor failure.** 3DS/CHALLENGED or a poll timeout returns
  `pending`; the claim stays `in_flight`, the date is untouched, and **dunning is NOT dispatched**
  — the customer may yet be charged, and dunning a paying customer is worse than being late.
- **Outcome beats go to this function's own reactive channel**, NOT
  `emitRenewalOutcomeHeartbeat`. That helper writes to `RENEWAL_OUTCOME_LOOP_ID`
  (`"internal-subscription-renewal-outcome"`), whose distribution feeds the internal cron's
  `renewal-outcome-distribution` assertion — mixing shopcx renewals in would skew a live assertion
  and manufacture false alarms. **A dedicated outcome channel + assertion for this path is still
  to be added before it runs at volume.**
- **Heartbeats carry counts, never a bare ok.** A cron that "succeeded" having selected zero subs
  is indistinguishable from a healthy quiet day — the exact shape that let the close snapshots go a
  month unwritten behind a green heartbeat.

## Node completeness

| requirement | how |
|---|---|
| owner | `retention` — [[../libraries/control-tower/registry]] `MONITORED_LOOPS` |
| kill switch | `enforceSwitch()` at the top of BOTH functions |
| heartbeat | `emitCronHeartbeat` (cron) + `emitReactiveHeartbeat` (attempt) |

## Status

**Built, registered, and NOT yet load-bearing** — no subscription carries `billing_source='shopcx'`
until the migration starts, so the cron selects zero rows every day. That is the intended state
until the first migration wave.

## Related

[[internal-subscription-renewals]] · [[../lifecycles/shopcx-subscriptions]] · [[../lifecycles/dunning]] ·
[[../libraries/commerce__shopify-subscription-client]] · [[../tables/subscriptions]] ·
[[../tables/appstle_contract_snapshots]]
