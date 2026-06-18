# libraries/portal/handlers/support

Portal support ticket entry point.

**File:** `src/lib/portal/handlers/support.ts`

## Exports

### `supportList` — const

```ts
const supportList: RouteHandler
```

### `supportTicket` — const

```ts
const supportTicket: RouteHandler
```

### `supportReply` — const

```ts
const supportReply: RouteHandler
```

Customer replies on an existing ticket. Inserts an inbound external `ticket_message`, re-opens the ticket if it was closed/pending, **then emits `ticket/inbound-message`** so [[../inngest/unified-ticket-handler]] runs (channel = the ticket's own channel). Blocked on archived / `do_not_reply` tickets.

### `supportCreate` — const

```ts
const supportCreate: RouteHandler
```

Opens a NEW ticket from the portal "Support" sidebar (`channel: "portal"`). Inserts ticket + inbound message, **then emits `ticket/inbound-message`** (`is_new_ticket: true`) so the AI orchestrator runs.

## Callers

_No internal callers found via static scan._ Routed via [[portal__handlers__index]] (`/api/portal?route=supportCreate|supportReply|…`).

## Gotchas

- **Inserting a `ticket_message` does NOT trigger the AI** — the unified handler fires ONLY on the `ticket/inbound-message` Inngest event; there is no DB trigger on `ticket_messages`. Both `supportCreate` and `supportReply` MUST emit that event after inserting. (They originally didn't — portal tickets sat open with no AI ever running; fixed 2026-06-18.) Any future portal write that should get AI must send the event too.
- **`channel: "portal"`, not `help_center`.** Portal tickets get their own AI Agent Channel config (seeded from live chat — same personality, threshold, turn limit, 15s response delay) and **always email** the customer a threaded digest on reply ([[portal__thread-email]]). The handler treats `portal` like `chat` for everything else — see [[../inngest/unified-ticket-handler]] § Channel behavior. (Pre-2026-06-18 portal tickets were mislabeled `help_center`; `scripts/retag-portal-tickets.ts` migrated them by their `portal.support.ticket_created` event.)
- **Sandbox defaults to `false`** (opt-in) so the handler sends rather than silently drafting.

---

[[../README]] · [[../../CLAUDE]]
