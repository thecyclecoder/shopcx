# Send an email reply

## Helper

```ts
import { sendTicketReply } from "@/lib/email";
```

**File:** `src/lib/email.ts` (line 107)

## Signature

```ts
async function sendTicketReply(args: {
  workspaceId: string;
  ticketId: string;
  fromName: string;
  toEmail: string;
  subject: string;
  bodyHtml: string;
  inReplyTo?: string;        // Gmail Message-ID of the original inbound email
  references?: string[];
  trackOpens?: boolean;
  trackClicks?: boolean;
}): Promise<{ resendEmailId: string }>
```

## Minimal example

```ts
// Always thread into the ticket's existing email_message_id
const { data: ticket } = await admin
  .from("tickets")
  .select("email_message_id, subject")
  .eq("id", ticketId).single();

const { resendEmailId } = await sendTicketReply({
  workspaceId,
  ticketId,
  fromName: "Suzie",
  toEmail: customer.email,
  subject: `Re: ${ticket.subject}`,
  bodyHtml: "<p>Hi! Thanks for reaching out…</p>",
  inReplyTo: ticket.email_message_id,
  references: ticket.email_message_id ? [ticket.email_message_id] : undefined,
  trackOpens: true,
  trackClicks: true,
});

// Persist the outbound message
await admin.from("ticket_messages").insert({
  ticket_id: ticketId,
  direction: "outbound",
  visibility: "public",
  author_type: "ai",
  body: bodyHtml,
  resend_email_id: resendEmailId,
});
```

## Outbound delay pattern

For non-system messages (AI / journey CTAs / agent replies that should have a delay), insert the row with `pending_send_at` set, then let [[../inngest/deliver-pending-send]] do the actual send:

```ts
const delaySec = workspace.response_delays?.email ?? 60;
await admin.from("ticket_messages").insert({
  ticket_id: ticketId,
  direction: "outbound",
  visibility: "public",
  author_type: "ai",
  body: bodyHtml,
  pending_send_at: new Date(Date.now() + delaySec * 1000).toISOString(),
});
```

The customer sees the message in the UI immediately; the actual transport call happens after the delay. Edit + Cancel buttons appear during the pending window.

## Gotchas

- **Thread via `email_message_id`** (Gmail Message-ID stored on the ticket). NOT `resend_email_id` — that's only on our outbound. See JOURNEYS.md § Email Threading.
- **`resend_email_id` not `resend_id`.** Supabase-js silently drops unknown columns on insert. Spelling matters. See [[../tables/ticket_messages]] gotchas.
- **Open + click tracking** is self-hosted, not Resend's. The helper passes the tracking flag to the body rewriter.
- **Sandbox mode**: when `workspaces.sandbox_mode=true`, outbound messages become internal notes. The helper checks this — don't bypass.
- **Reply-to / from**: `workspaces.transactional_from_email`, `transactional_from_name`, `transactional_reply_to_email` control these.

## Related

[[send-chat-reply]] · [[../libraries/email]] · [[../integrations/resend]] · [[../tables/ticket_messages]] · [[../inngest/deliver-pending-send]]
