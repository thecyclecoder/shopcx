# inngest/returns

Returns refund pipeline: returns/process-delivery (EasyPost delivered → fire issue-refund) and returns/issue-refund (partial refund OR store credit, close return, email customer).

**File:** `src/lib/inngest/returns.ts`

## Functions

### `returns-process-delivery`
- **Trigger:** event `returns/process-delivery`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspace_id" }]`


### `returns-issue-refund`
- **Trigger:** event `returns/issue-refund`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspace_id" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/dashboard_notifications]]
- [[../tables/returns]]
- [[../tables/order_refunds]] (via refundOrder — Phase 2 idempotency mirror)

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/orders]]

## Header notes

```
Inngest returns pipeline:
  returns/process-delivery → fires returns/issue-refund instantly
  returns/issue-refund     → reads stored net_refund_cents, refunds
                             or issues store credit, closes return,
                             emails customer. Escalates if amount
                             missing — never auto-refunds $0.

Design notes:
  - Dispose (Shopify reverseFulfillmentOrderDispose) was previously
    gating the refund. We don't use Shopify's inventory bookkeeping
    for returns, so it was pure dead weight that blocked refunds
    when older returns lacked reverse fulfillment line item IDs.
  - The 24-hour inspection wait was for that dispose step. With
    dispose gone, the refund fires as soon as EasyPost confirms
    delivery. Customer experience > inventory accounting.
  - The refund amount is the value STORED on the return row at
    create time (computed from items + label policy + resolution
    type). The pipeline never re-derives it — if it's missing or
    zero, that's a creation-time bug, surfaced as a dashboard
    notification.
  - Refund idempotency (Phase 2): Inngest step retries (this function
    has retries: 2) compute a stable request_key from the return_id
    and pass it to refundOrder, so a retried refund reuses the same
    key and short-circuits at the pre-dispatch guard — the money can
    only move once. The order_refunds mirror ensures every refund has
    an audit row and catches double-fires across all caller sites.
    See [[../tables/order_refunds]], [[../libraries/refund]].
```

---

[[../README]] · [[../integrations/inngest]] · [[../tables/order_refunds]] · [[../libraries/refund]] · [[../../CLAUDE]]
