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
| `TicketInvestigation` · `investigateTicket(admin, idOrUrl)` | one call → the full merged picture (ticket + customer + messages + directions + jobs + merges) |
| `DeliveryState` · `TurnDiagnosis` · `buildTurnTimeline(inv)` | per-turn delivery diagnosis — did each turn's reply actually SEND? (surfaces the Sofia-class silent-turn) |

## Callers

`/investigate-ticket` skill · hand-fix diagnosis · Sol context briefs.
