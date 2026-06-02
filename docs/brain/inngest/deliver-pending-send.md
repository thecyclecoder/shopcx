# inngest/deliver-pending-send

Cron: scans `ticket_messages.pending_send_at <= now()` and actually sends the message via Resend/Twilio/Meta. The reason outbound messages appear in the UI immediately but ship after a delay.

**File:** `src/lib/inngest/deliver-pending-send.ts`

## Functions

### `deliver-pending-sends`
- **Trigger:** cron `* * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/ticket_messages]]

## Tables read (not written)

- [[../tables/tickets]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
