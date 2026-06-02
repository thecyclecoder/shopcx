# Send a chat reply

Chat replies don't go through a transport API at send time — they're inserted into [[../tables/ticket_messages]] with `pending_send_at`, and the widget polls the database for them.

## Pattern

```ts
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

// Respect the workspace's chat delay
const { data: workspace } = await admin
  .from("workspaces")
  .select("response_delays")
  .eq("id", workspaceId).single();

const delaySec = workspace?.response_delays?.chat ?? 0;

await admin.from("ticket_messages").insert({
  ticket_id: ticketId,
  direction: "outbound",
  visibility: "public",
  author_type: "ai",          // or "agent"
  body: "<p>Got it! Let me check that for you.</p>",
  pending_send_at: new Date(Date.now() + delaySec * 1000).toISOString(),
});
```

That's it. The chat widget at `/widget/[workspaceId]/page.tsx` polls the ticket's messages list and shows new messages with `pending_send_at <= now()`.

## Chat-end signal

A chat message containing "send you an email" triggers `chatEnded` in the widget — disables input, hides typing bubbles, shows "conversation ended."

If you intend to end the chat conversation (e.g. on escalation), include that phrase:

```ts
body: "<p>Got it — I'll have someone follow up. I'll send you an email at " + customer.email + ".</p>"
```

## Inline forms (journey embeds)

Live-chat journeys are rendered as inline forms inside the chat widget. To embed a journey form in a chat message, include a `<!--JOURNEY-INLINE:{token}-->` comment in the body — the widget detects it and renders the form. The unified handler does this automatically when `launchJourneyForTicket()` is called on a chat ticket.

## Gotchas

- **Don't bypass `pending_send_at`.** Even chat needs the delay — without it, the customer sees a robotically instant reply.
- **`author_type='ai'`** when AI sent it; `'agent'` when a human did. The "Agent intervened" flag flips on the first `author_type='agent'` outbound.
- **Idle-to-email switch**: if the customer is idle > 3 min, the next message can be sent over email instead. Use [[send-email-reply]]. See feedback_chat_idle_journey_delivery.
- **Length**: chat messages should be SHORT. 2 sentences per paragraph max. See feedback_ai_response_quality.

## Related

[[send-email-reply]] · [[../tables/ticket_messages]] · [[../inngest/deliver-pending-send]] · [[../lifecycles/ticket-lifecycle]]
