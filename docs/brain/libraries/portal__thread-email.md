# libraries/portal/portal-thread-email

Email delivery for `portal`-channel tickets: our most recent message on top, conversation history below, **external messages only**.

**File:** `src/lib/portal/portal-thread-email.ts`

## Why

A portal ticket is opened from the customer-portal "Support" sidebar ([[portal__handlers__support]]). The customer isn't sitting in a live chat window, so unlike `chat` (which only emails on idle) `portal` **always** emails the customer when we respond. The portal UI shows the thread too; the email is the guaranteed delivery.

## Exports

### `sendPortalThreadEmail` — function

```ts
async function sendPortalThreadEmail(admin: SupabaseClient, wsId: string, ticketId: string): Promise<string | null>
// Returns the Resend message id (also threaded back onto the ticket), or null on no-op/failure.
```

Builds the email body:
- **Top:** the latest `outbound` external message (our reply). Any embedded journey form (`<!--JOURNEY:{…}-->`) is converted to a styled CTA button — forms don't render in email.
- **Below:** "Conversation history" — every other external message, newest first, labeled `You` / `Support` with an ET timestamp.

Then sends via [[email]] `sendTicketReply`, saves the sent Message-ID onto `tickets.email_message_id` so the customer's email reply threads back into the same ticket, and logs via [[email-tracking]] `logEmailSent`.

## Callers

- [[../inngest/unified-ticket-handler]] — `send()` immediate path (`ch === "portal"`).
- [[../inngest/deliver-pending-send]] — delayed path (`ticket.channel === "portal"`).

## Gotchas

- **External only.** Filters `visibility = "external"` — internal system notes, AI drafts, and `[System] …` orchestration logs are never emailed.
- **Call AFTER inserting the outbound row** — it reads the freshly-inserted message as the "latest" on top.
- **No-op when** the ticket has no customer email or no external messages (returns `null`).

---

[[../README]] · [[portal__handlers__support]] · [[../../CLAUDE]]
