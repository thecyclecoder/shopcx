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

## Ground truth

**Ticket a4e79e9d** (2026-06-15): Customer `affcdc47` (jratt@mac.com) and `40c66b13` (jratt@me.com) share link group `1dab5c2f`. A ticket on one record showed 0 orders, 0 subscriptions while the group contained 29 orders and $3,241.92. Apple aliases and re-registrations make this common.

## Related

[[../tables/customer_links]] · [[../libraries/tickets-read]] · [[../libraries/fraud-linked-customers]]
