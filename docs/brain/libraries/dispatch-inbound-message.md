# dispatch-inbound-message

**Phase 2 of [[../specs/durable-inbound-dispatch-no-silently-lost-ticket-event]].** Shared durable dispatcher for the `ticket/inbound-message` event. Every ingest chokepoint (widget messages, webhooks/email+sms+meta, portal support, journeys, csat, apply-playbook, help) routes through this helper so the raw fire-and-forget `inngest.send` sends disappear from the ingest surface.

**File:** `src/lib/inngest/dispatch-inbound-message.ts`

## Problem it solves

Before this helper, every ingest chokepoint did a fire-and-forget `inngest.send({name:'ticket/inbound-message'})` after inserting the customer message. If Inngest silently dropped the send (cold start, delivery blip) the customer sat unanswered forever with **no trace of a lost event** — ticket `c4889020` was the case-in-point. A ticket/inbound-message event should be re-fireable when lost.

`dispatchInboundMessage` closes the gap at the source:
1. **Stamps `dispatch_pending_at = now` on the just-inserted `ticket_messages` row** (durable intent — a row on disk that says "an ingest chokepoint asked for handling here").
2. **Fires the `ticket/inbound-message` event** through the Inngest client.

The counterpart is [[../inngest/unified-ticket-handler]] `clearDispatchIntent`: when the handler claims a turn (receives the event), it clears the stamp on un-cleared inbound messages for that ticket. That pair — set-on-send + clear-on-claim — is what makes an un-cleared stamp older than the Phase-3 settle window an **unambiguous LOST send** that the backstop reconciler can re-fire deterministically (instead of Phase 1's message-age heuristic).

## Exports

### `async dispatchInboundMessage(args: DispatchInboundMessageArgs): Promise<void>`

Phase-2 durable dispatch. Stamps the intent on the message row **BEFORE** firing the event — the on-disk stamp is what makes a lost send recoverable.

**Order matters:** stamp then send. If the send throws, the stamp on disk lets the Phase-3 reconciler re-fire the event after the settle window (an un-cleared stamp with no handler-side activity is precisely the "lost send" signal). If we sent first and then stamped, a crash between send and stamp would leave a lost-send with no durable evidence — the pre-Phase-2 state.

**Signature:**
```ts
export async function dispatchInboundMessage(args: DispatchInboundMessageArgs): Promise<void>
```

**Args:**
```ts
export interface DispatchInboundMessageArgs {
  admin: ReturnType<typeof createAdminClient>;
  workspaceId: string;
  ticketId: string;
  messageBody: string;
  channel: string;
  isNewTicket: boolean;
  /** UUID of the freshly-inserted inbound `ticket_messages` row that this event answers to. Pass
   *  `null` ONLY for synthetic sentinel events (journey resume signals, playbook wakes) that have
   *  no real customer message row. When set, the helper stamps `dispatch_pending_at = now` on that
   *  specific row BEFORE firing. */
  dispatchMessageId: string | null;
  /** Extra payload keys some sentinel senders attach (journey_session_id, payment_method_id). 
   *  Optional so the helper's contract stays a strict superset of raw `inngest.send({data})` shape. */
  extra?: Record<string, unknown>;
}
```

**Stamps with a compare-and-set on `dispatchMessageId` and `ticketId`** — a caller can never accidentally stamp a stale row from a different ticket. If the row disappeared under us (a merge redirect racing) the send still fires; the backstop cron will catch a truly-lost handler via its message-age floor for pre-Phase-2 rows.

### `async clearDispatchIntent(admin: Admin, ticketId: string): Promise<void>`

Handler-side counterpart: clears any un-cleared `dispatch_pending_at` on this ticket's newest inbound customer messages when the unified handler claims the turn. **Idempotent** — clearing an already-clear row is a no-op update; a ticket with no stamped rows is a no-op.

**Signature:**
```ts
export async function clearDispatchIntent(admin: Admin, ticketId: string): Promise<void>
```

Called from [[../inngest/unified-ticket-handler]] at the top of the run (before every gate), so a handler that legitimately declines the turn (`ai_disabled` / `do_not_reply` / sentinel-no-playbook / empty inbound / spam) still counts as **CLAIMED** — the event was delivered, and Phase-3 must not re-fire it. The clear is what makes "un-cleared stamp older than settle" a genuine lost-send signal.

Clears **all** un-cleared inbound customer rows for the ticket (not just the newest) so a ticket whose ingest fired multiple stamps rapidly (rare but possible on a burst reply) collapses to a single handler run. Matches the handler's per-ticket concurrency=1 contract.

## Sentinel events

Sentinel events (journey/complete `address_confirmed` / `items_selected`, journey/submit-payment `payment_method_added`, apply-playbook `playbook-apply`) don't have a real INBOUND customer message row on the ticket — they're a coordination signal to wake a playbook. For those the caller omits `dispatchMessageId`; the helper simply fires the event (nothing to stamp). 

**Losing a sentinel is far less severe than losing a customer reply**: the customer's real message already has its own durable dispatch through the original channel.

## Callers

Every ingest chokepoint routes through this helper:
- `src/app/api/widget/[workspaceId]/messages/route.ts`
- `src/app/api/webhooks/email/route.ts`
- `src/app/api/webhooks/sms/route.ts`
- `src/app/api/webhooks/meta/route.ts`
- `src/app/api/journey/[token]/complete/route.ts`
- `src/app/api/journey/[token]/submit-payment/route.ts`
- `src/app/api/tickets/[id]/apply-playbook/route.ts`
- `src/app/api/workspaces/[id]/csat/route.ts`
- `src/app/api/help/[slug]/tickets/route.ts`
- `src/lib/portal/handlers/support.ts`

Compliance: grep for `inngest.send({name:'ticket/inbound-message'})` in `src/app/api/**` and `src/lib/portal/**` — only [[../inngest/unified-ticket-handler]]'s own re-fire and [[../inngest/unanswered-inbound-backstop-cron]] may still fire raw.

## Downstream events sent

- `ticket/inbound-message` → [[../inngest/unified-ticket-handler]] (the initial dispatch)

## Tables written

- [[../tables/ticket_messages]] — the `dispatch_pending_at` stamp (when `dispatchMessageId` is set)

## Verification

Unit + integration tests in `src/lib/inngest/dispatch-inbound-message.test.ts` show the helper writes the dispatch-intent stamp before the send and that [[../inngest/unified-ticket-handler]] `clearDispatchIntent` clears it on claim. `npx tsc --noEmit` clean.

## Gotchas

- The stamp is written in the **same request as the message insert**, making it durable before any async send happens.
- If Inngest delivery fails and the caller retries, the compare-and-set re-apply is a no-op (already stamped `dispatch_pending_at`).
- The Phase-3 reconciler relies on this stamp's presence + age to detect lost sends deterministically — a dropped stamp or a missing helper call leaves an event unrecoverable.

---

[[../README]] · [[inbound-dispatch-gate]] · [[../inngest/unified-ticket-handler]] · [[../inngest/unanswered-inbound-backstop-cron]] · [[../tables/ticket_messages]]
