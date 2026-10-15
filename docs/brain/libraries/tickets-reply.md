# tickets-reply

`src/lib/tickets-reply.ts` — send a customer reply that lands on the SAME ticket + email thread. A thin wrapper over `deliverTicketMessage` ([[ticket-delivery]]) that re-reads the inserted outbound row to return the `ticketMessageId` + `providerMessageId`, so a caller (hand-fix, tooling) gets a handle on what it sent. Read side: [[tickets-read]]. Full mutation surface: [[tickets-mutate]].

## Exports

| Symbol | Purpose |
|---|---|
| `SendThreadedReplyArgs` | `{workspaceId, ticketId, message, channel?, sandbox?}` |
| `ThreadedReplyResult` | `{ticketMessageId, providerMessageId}` |
| `sendThreadedReply(admin, args)` | deliver `message` on the ticket's channel (default resolved from the ticket), threading via the prior inbound's `email_message_id` (in-reply-to). `sandbox` stores an internal draft instead of sending. |

## Reply-destination note

`deliverTicketMessage` sends to the ticket's `customer_id` email — NOT the inbound from-address (`email_message_id` is threading only). Account-linking that reassigns identity must update `ticket.customer_id` (or `update_customer_info`) before replying, or the reply routes to the wrong address. See [[../lifecycles/customer-portal]] / account-linking.

## `message` is PLAIN TEXT, not HTML

Pass paragraphs separated by blank lines (`\n\n`) — [[ticket-delivery]]'s `toHtml` splits on `\n\n+` and wraps each block in `<p>` itself (single `\n` → `<br>`). Handing it pre-wrapped `<p>…</p>` HTML has no `\n\n`, so the whole string is treated as ONE paragraph and wrapped a second time, storing `<p><p>a</p><p>b</p></p>`. It still renders (the parser auto-closes the outer `<p>`) but leaves a stray empty paragraph — and a caller that "fixes" it by re-sending just duplicates the message to the customer. Ticket b28e7744 (Juana, 2026-09-04) is the ground-truth case.

## Callers

Hand-fixes · one-off reply tooling. (Sol's first-touch reply ships through [[../../scripts/builder-worker]]'s send path, not this wrapper.)
