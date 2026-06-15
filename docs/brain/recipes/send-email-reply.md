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
  toEmail: string;
  subject: string;
  body: string;              // HTML — wrapped in a styled <div> by the helper
  inReplyTo: string | null;  // Gmail Message-ID; sets BOTH In-Reply-To and References
  agentName: string;         // persona display name, e.g. "Suzie" → from "Suzie via {workspaceName}"
  workspaceName: string;
}): Promise<{ messageId?: string; error?: string }>
```

The `from` line is `"{agentName} via {workspaceName} <support@{resend_domain}>"`. Open/click tracking is **not** a param — the helper doesn't take `fromName`, `ticketId`, `references[]`, or `trackOpens/trackClicks`. `subject` gets a `Re:` prefix automatically when `inReplyTo` is set.

## Minimal example

```ts
const { data: ticket } = await admin
  .from("tickets")
  .select("email_message_id, subject")
  .eq("id", ticketId).single();

const { messageId, error } = await sendTicketReply({
  workspaceId,
  toEmail: customer.email,
  subject: ticket.subject,
  body: "<p>Hi! Thanks for reaching out…</p>",
  inReplyTo: ticket.email_message_id ?? null,
  agentName: "Suzie",
  workspaceName: "Superfoods Company",
});
if (error || !messageId) throw new Error(`send failed: ${error}`);

// Persist the outbound message (check the returned error — a bad insert is silent otherwise)
const { error: insErr } = await admin.from("ticket_messages").insert({
  ticket_id: ticketId,
  direction: "outbound",
  visibility: "external",   // CHECK constraint: 'external' | 'internal' — NOT 'public'
  author_type: "ai",        // 'customer' | 'agent' | 'ai' | 'system'
  body,
  resend_email_id: messageId,
  sent_at: new Date().toISOString(),
});
if (insErr) throw new Error(insErr.message);
```

## Outbound delay pattern

For non-system messages (AI / journey CTAs / agent replies that should have a delay), insert the row with `pending_send_at` set, then let [[../inngest/deliver-pending-send]] do the actual send:

```ts
const delaySec = workspace.response_delays?.email ?? 60;
await admin.from("ticket_messages").insert({
  ticket_id: ticketId,
  direction: "outbound",
  visibility: "external",
  author_type: "ai",
  body,
  pending_send_at: new Date(Date.now() + delaySec * 1000).toISOString(),
});
```

The customer sees the message in the UI immediately; the actual transport call happens after the delay. Edit + Cancel buttons appear during the pending window.

## Gotchas

- **Thread via `email_message_id`** (Gmail Message-ID stored on the ticket). NOT `resend_email_id` — that's only on our outbound. See [[../journeys/README]] § Email Threading.
- **`resend_email_id` not `resend_id`.** Supabase-js silently drops unknown columns on insert. Spelling matters. See [[../tables/ticket_messages]] gotchas.
- **`visibility` is a CHECK constraint: `'external'` or `'internal'` only.** `'public'` throws `ticket_messages_visibility_check`. The insert fails *silently* unless you capture `error` — always `.select()` or check the returned error.
- **`sendTicketReply` destructures named args.** Passing `bodyHtml`/`fromName` instead of `body`/`agentName` doesn't error — the wrong keys are just `undefined`, and (with sandbox off) Resend sends a garbled "undefined via undefined" email. Match the signature exactly.
- **Sandbox mode**: when `workspaces.sandbox_mode=true`, `getResendClient` returns null for non-member recipients and `sendTicketReply` returns `{ error: "Resend not configured" }` — nothing sends. Check the result.
- **Reply-to / from**: `from` is built from `agentName` + `workspaceName` + `resend_domain`; `replyTo` is `workspaces.support_email` (falls back to `support@{resend_domain}`).

## Related

[[send-chat-reply]] · [[../libraries/email]] · [[../integrations/resend]] · [[../tables/ticket_messages]] · [[../inngest/deliver-pending-send]]
