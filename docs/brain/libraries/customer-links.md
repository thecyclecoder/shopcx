# libraries/customer-links

Resolve a customer to all UUIDs in the same link group — when a person has multiple records (e.g., separate emails, Apple aliases), link-group expansion ensures reads return the combined history across all of them.

**File:** `src/lib/customer-links.ts`

## Why it exists

When a person has two customer records and one is linked to the other via [[../tables/customer_links]], reads on "this customer" must fan out to ALL records in the group. A director reading a ticket with a linked-but-separate record was handed an empty surface with 29 orders showing as zero — the ground-truth incident that drove this (ticket a4e79e9d, 2026-06-15).

Linking is **display-only** — these remain separate real rows, same human. A write operation keeps the ticket's own `customer_id` as the identity. Linking is only for READ expansion.

## Exports

- `linkGroupIds(admin, workspaceId, customerId): Promise<string[]>` — returns every customer UUID in the same link group, including self. Returns `[customerId]` when there is no group.

## Usage pattern

Any query that reads "per-person" data — subscriptions, orders, returns, loyalty balance, payment methods — uses `.in("customer_id", await linkGroupIds(...))` instead of `.eq`:

```ts
const ids = await linkGroupIds(admin, workspaceId, customerId);
const { data: orders } = await admin
  .from("orders")
  .select("…")
  .eq("workspace_id", workspaceId)
  .in("customer_id", ids);  // ← expands to the link group
```

The `.in` is safe when the group is just one person: `linkGroupIds` returns `[customerId]` → `.in("customer_id", [customerId])` behaves identically to `.eq`.

## Callers

- [[../libraries/tickets-read]] — `getLinkedSubscriptions`, `getLinkedOrders`, `getLinkedReturns`
- `scripts/open-tickets.ts` — the queue surface
- `src/lib/cs-director.ts` — the director's customer context  
- [[../libraries/fraud-linked-customers]] — fraud case expansion
- [[../libraries/cx-agent-sdk]] — Sonnet's customer profile + balances
- [[../libraries/action-executor]] — `create_return`, `full_order_refund`, `update_line_item_price`, `partial_refund`, `redeem_points_as_refund`, `crisis_set_auto_readd`, and `verifyActionInDB` scope helpers all widen their `customer_id` filters to the link group so an order/sub/loyalty row/crisis action sitting on a linked-sibling profile isn't invisible. The ownership property is preserved: an unrelated workspace customer still returns zero rows because `linkGroupIds` only expands to the true peers.

## Ground truth

**Ticket a4e79e9d** (2026-06-15): Customer `affcdc47` (jratt@mac.com) and `40c66b13` (jratt@me.com) share link group `1dab5c2f`. A ticket on one record showed 0 orders, 0 subscriptions while the group contained 29 orders and $3,241.92. Apple aliases and re-registrations make this common.

**Ticket bafa0f7a** (2026-09-17): A 3+ year customer received Hazelnut French Roast GROUND coffee she could not use (Keurig-only household) on order SC138373 and asked for a return label. Sol swapped her active sub to K-Cups Cocoa and shipped a free replacement (SC138882), but `create_return` failed repeatedly with "Order SC138373 not found" and the ticket escalated. Root cause: SC138373's `customer_id` was a linked peer (270c88ba / nataliepalm57@gmail.com) auto-linked from an inline mention, while the ticket's resolved `ctx.customerId` was 827b7894 (npsheppard@clinicalconsultants.org). `create_return` used `.eq("customer_id", ctx.customerId)` on the orders lookup, so any order sitting on a linked sibling account was invisible. Fixed by spec `create-return-order-lookup-must-span-linked-accounts` — the `create_return` order lookup and every sibling `.eq("customer_id", ctx.customerId)` in [[../libraries/action-executor]] (`update_line_item_price` crisis lookup, `partial_refund` loyalty reconcile, `full_order_refund` order lookup, `redeem_points_as_refund` loyalty member, `crisis_set_auto_readd`, `verifyActionInDB` scope helper) now widen through `linkGroupIds`. Mirrors the earlier payment-methods widening in `payment-method-lookups-must-span-linked-accounts` (#2816).

## Related

[[../tables/customer_links]] · [[../libraries/tickets-read]] · [[../libraries/fraud-linked-customers]]
