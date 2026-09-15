# `src/lib/inngest/one-time-charges.ts`

Drives [[../tables/one_time_charges]]. Shares the Shopify mechanics of
[[shopify-subscription-renewals]] but none of its subscription bookkeeping.

## Functions

| id | kind | trigger | owner |
|---|---|---|---|
| `one-time-charge-cron` | cron | `20 * * * *` (hourly) | retention |
| `one-time-charge-attempt` | reactive | `one-time-charge/attempt` | retention |

**Hourly, not daily.** A one-time charge is normally queued in response to something a human or an
agent just did, so a day of latency would make the mechanism useless for its own use case.

## What it does NOT do

- **No cycle-charge ledger row.** The `one_time_charges` row is its own claim — see the table page.
- **No `next_billing_date` to advance.** There is no next.
- **No dunning dispatch.** A declined one-time charge is not a subscription at risk; routing it
  into the ladder would rotate the customer's card and email them about a subscription they do not
  have.

## The sweep, and the scoping mistake it avoids

The cron also reconciles crashed runs, cancels any contract a failed cancel left live, and links +
**reclassifies** landed orders.

⚠️ It is scoped to workspaces with rows that **need attention** (`status='charging'`, or
`status='charged'` with a null `order_id`) — *not* to the workspaces that happened to have a due
charge that tick. Those are different sets: an order lands minutes after its charge settles, by
which time there may be nothing due at all, and keying the sweep off the due list would leave that
order unlinked and still classified `recurring` forever.

## Retries

`one-time-charge-attempt` retries **transport faults only**. `executeOneTimeCharge` releases its
claim back to `pending` before throwing, so a retry re-claims cleanly; a settled decline returns
normally and is never retried. Same rule as the renewal worker: treating "we could not reach
Shopify" as a decline would abandon a charge whose card was never asked.

## Node completeness

Both ids are in `MONITORED_LOOPS` ([[../libraries/control-tower-node-registry]]) with
`owner: retention`, both emit an end-of-run heartbeat, and both resolve a kill switch — verified by
resolving the ancestry against a hand-built map: a `retention` department switch cascades to both,
and an own-row switch works. An **unregistered** node resolves to `{off:false}` — a switch that
silently can never fire.

## Related

[[../tables/one_time_charges]] · [[../libraries/commerce__shopify-one-time-charge]] ·
[[shopify-subscription-renewals]] · [[../lifecycles/shopcx-subscriptions]]
