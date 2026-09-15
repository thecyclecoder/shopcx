# tickets-read

`src/lib/tickets-read.ts` — the deterministic READ surface for a support ticket (no raw table queries at call sites). Powers the `/investigate-ticket` skill and any code that needs a ticket's full picture. Write side: [[tickets-mutate]]. Threaded replies: [[tickets-reply]].

## Exports

| Symbol | Purpose |
|---|---|
| `parseTicketRef(idOrUrl)` | extract the ticket UUID from a bare id or a dashboard URL |
| `specSlugForTicketHandle(ticketId)` | the `ticket-handle-<8>` spec_slug convention |
| `TicketRow` / `CustomerLite` / `TicketMessageRow` / `TicketDirectionRow` / `HandleJobRow` | row shapes for reads |
| `getTicket(admin, idOrUrl)` | the ticket row |
| `getCustomerLite(admin, customerId)` | minimal customer (email/name/phone) |
| `getTicketMessages(admin, ticketId)` | all messages in order |
| `getTicketDirections(admin, ticketId)` | Sol's Direction rows |
| `getTicketHandleJobs(admin, workspaceId, ticketId)` | the `ticket-handle` agent_jobs for the ticket |
| `getMergedFromTickets(admin, …)` | tickets auto-merged into this one |
| `getLinkedSubscriptions(admin, workspaceId, customerId)` | subscriptions across the ticket customer's entire link group |
| `getLinkedOrders(admin, workspaceId, customerId, limit?)` | recent orders across the link group (newest first, default 6 items) |
| `getLinkedReturns(admin, workspaceId, customerId, limit?)` | returns across the link group (newest first, capped) |
| `TicketInvestigation` · `investigateTicket(admin, idOrUrl)` | one call → the full merged picture (ticket + customer + messages + directions + jobs + merges) |
| `DeliveryState` · `TurnDiagnosis` · `buildTurnTimeline(inv)` | per-turn delivery diagnosis — did each turn's reply actually SEND? (surfaces the Sofia-class silent-turn) |

## Linked-customer surfaces

When a person has multiple customer records linked via [[../tables/customer_links]], every read surface must include ALL records in that group, not just the one the ticket landed on. Per the ground-truth incident (ticket a4e79e9d): records linked 2026-06-15, but the surface showed the customer's 29 orders and 3 subscriptions as zero because it only queried the single record the email matched.

**The three linked-customer getters** — `getLinkedSubscriptions`, `getLinkedOrders`, `getLinkedReturns` — each call [[../libraries/customer-links]] `linkGroupIds` to resolve a customer to all IDs in the same link group, then query using `.in("customer_id", ids)` instead of `.eq`. Linking is display-only (separate real rows, same human); the widening is read-only. A 1-person-1-record ticket reads `[customerId]` (safe drop-in for `.eq`) and works unchanged.

Ground truth: ticket a4e79e9d (2026-06-15), customer `affcdc47` + `40c66b13`, link group `1dab5c2f` → the surface showed 0 orders, 0 subscriptions while the group held 29 orders and $3,241.92.

## Callers

`/investigate-ticket` skill · hand-fix diagnosis · Sol context briefs · `scripts/open-tickets.ts` (queue surface) · `src/lib/cs-director.ts` (director brief)
