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
| advance, on the due day | **at least one full cadence**, even when the charge runs before the row's time of day (cron 10:00 UTC; most rows are due later in the day). Without the forced step the date never moved and the cycle key collided every morning, so the sub was charged once and then never again (2026-10-09: 36064133293, 36063969453; 2026-10-13: 36020289709, 36020093101) |

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

## ⭐ The rolling schedule pin

Advancing `next_billing_date` fixes OUR calendar. Shopify's stays where it was, and a customer
looking at the portal — or any Shopify surface reading the contract — sees the old date. Worse, the
renewal worker resolves the cycle to bill BY DATE and skips a cycle already `BILLED`, so a date that
drifts into a spent cycle **strands the subscription silently** (measured on the 2026-09-16 cohort:
two of three subs that had just charged were already dead, one by eight minutes).

So after a successful charge and advance, the worker pins the cycle that lands on the new
`advanceTo` (plus one more) via `shopifySyncBillingSchedule`. One mutation per renewal; the
customer's Shopify-visible schedule stays permanently correct even though Shopify only materializes
~12 months of cycles at a time. See [[../libraries/commerce__shopify-subscription-client]] §
"Keeping a customer's own dates" for why this is the only mechanism that works on `WEEK`/n cadences,
and why converting those cadences to `MONTH` instead was priced at ~$147,625/yr and rejected.

**Non-fatal by construction.** The charge already succeeded and the worker bills by an explicit
`billingCycleSelector` it resolves itself, so a failed pin is a display drift — never a missed or
duplicated charge. It logs and moves on.

## Flow

**`shopifySubscriptionRenewalCron`** — daily `0 10 * * *` (an hour after the internal cron):
kill-switch gate → **settle pending attempts** → keyset-paginated candidate select → dunning
retry-window filter → fan out one event per sub (stamped with `expected_next_billing_date`) →
heartbeat carrying `{ due, muted_null_billing_date, settled }`.

**Settling pending attempts (`settlePendingShopcxClaims`).** A pending attempt (3DS, or our 30s poll
timed out) leaves its cycle claim `in_flight`, and nothing else resolves it: the billing-attempt
webhook only records, and `claimCycleCharge` never reclaims another claimant's `in_flight`. Before
this step that wedged the sub for good — every later run refused the cycle, `guardRecentOrderNow`
blocked every Order Now, a slow success was never advanced and a later failure never reached
dunning. Now every `in_flight` claim with `source` `shopcx` (worker) or `shopcx_portal_order_now`
(portal Order Now) older than 1h is read back from Shopify by the idempotency key we sent
(`findContractBillingAttempt`):

| Shopify says | settle does |
|---|---|
| succeeded | advance our date (compare-and-set on the date the claim was keyed on), THEN resolve the claim `succeeded` — advance first, so a crash in between never strands a `succeeded` claim on an old date |
| failed | resolve the claim `failed`, nothing else. The sub is still due, so this same run selects it, the worker reclaims the failed cycle under the same Shopify key, Shopify replays the decline, and the worker's decline path dispatches dunning — once |
| still pending / not found / unreadable | leave it `in_flight`. Never released on a guess; the wedged-cycle monitor ([[../libraries/control-tower]] `countRenewalWedgedCycles`) now covers ShopCX `in_flight` rows |

**`shopifySubscriptionRenewalAttempt`** — per sub, concurrency 8:
kill-switch → stale guard → **cycle key from the dispatched date** → resolve the due cycle from
Shopify → **claim the cycle** → `price-check-log` (with the one pre-charge repair) → charge →
settle → advance / dun.

**The claim key comes from the DISPATCHED date.** `cycleKeyFromDispatchedNextBillingDate(expected_next_billing_date)`,
never a live read. A successful charge advances `next_billing_date`, so keyed off the live row an
order-now that loaded the sub seconds after the cron charged claimed the NEXT cycle and charged
again — the internal engine's sub e9b8a6d9 shape. Both dispatchers stamp it (`subscriptionOrderNow`
now sends the pre-charge date plus `order_now: true`); an event without one is refused
(`missing_dispatched_cycle`). An order-now whose cycle the cron already took is dropped by the stale
guard and logs the `nothing_due` marker. The portal ShopCX Order Now, which charges directly, claims
the same key first ([[../libraries/portal__handlers__order-now]]).

**`price-check-log` is log-only (CEO 2026-10-10).** [[../libraries/commerce__shopcx-renewal-price-check]]
compares the contract with the pricing rules and files one `billing_alert` card on a gap over
$1 / 2%. It never blocks, delays or changes the charge, because the contract is the price. A wrong
contract gets fixed where it was written (ingest normalization, migration, line-ops). Earlier,
Dylan had said not to check at all; he chose log-only on 2026-10-10. A dry run over the 172 active
ShopCX subs on 2026-10-10 found 168 matching, 3 with no rule lines, and 1 real overcharge: Dylan's
own test contract `35917070509`, which bills Amazing Creamer at $69.95 with no S&S.

**The one repair.** An OVERCHARGE on a contract with **no structural allocation at all**
(`shouldRepairUnnormalizedContract`) is the shape a failed ingest normalization leaves: lines at
MSRP, S&S only as an inert checkout copy, a new PDP subscriber about to pay +33% a unit. The step
runs the idempotent `shopcxNormalizeNewContract` (the write path for exactly that shape) before the
charge, then re-checks and logs. Normalizing can only lower the charge to the rules price; any other
gap stays log-only.

## Gotchas

- **Keyset-paginate, always.** A bare select caps at the PostgREST 1000-row max and the overflow
  is dropped silently — and a dropped candidate here is a renewal that never happens.
- **The stale guard is not optional.** `expected_next_billing_date` is stamped on the fan-out
  event and re-checked live; if it moved, another attempt already took this cycle and charging
  again would double-bill *and* reopen dunning.
- **Claim before charging.** `claimCycleCharge` on `(subscription_id, cycle_key)` is our guard;
  Shopify's `idempotencyKey` is the second. An Inngest step retry is only safe because of both.
- **Customer-pressed order-now on already-billed cycle (nothing_due marker).** When the dispatcher stamps `order_now: true` on the renewal-attempt event (indicating a customer-pressed order-now from the portal or AI executor, not a cron renewal), and the attempt resolves no chargeable cycle (`no_cycle_due`) or the cycle is already claimed (`cycle_already_claimed`), the handler calls [[../libraries/order-now-verify]] `logOrderNowNothingDue` to write a `subscription.order_now_nothing_due` customer_event. The async order-now verify reads this marker as `hasNothingDueSkip` and stamps `verified_outcome='nothing_due'` — a distinguishable outcome that lets the ticket confirm "no charge; next order <date>" instead of looping on `unknown` (ticket dd5e2ba0 — Ashley Denson). See [[../specs/order-now-verify-nothing-due-verdict-for-skipped-spent-cycle]].
- **Always pass `billingCycleSelector`.** Omitting it bills Shopify's *current* calendar cycle,
  which after a migration re-anchor is usually not the one intended.
- **A pending attempt is neither success nor failure.** 3DS/CHALLENGED or a poll timeout returns
  `pending`; the claim stays `in_flight`, the date is untouched, and **dunning is NOT dispatched**
  — the customer may yet be charged, and dunning a paying customer is worse than being late. The
  next cron run settles it (see Flow).
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
