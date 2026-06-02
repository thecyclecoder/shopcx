# Escalate a ticket to a human

## Helper

```ts
import { handleEscalation } from "@/lib/escalation";
```

**File:** `src/lib/escalation.ts` (line 8)

## Signature

```ts
async function handleEscalation(args: {
  workspaceId: string;
  ticketId: string;
  reason: string;                  // human-readable reason
  holdingMessage?: string;         // optional override for the holding message
  assignTo?: string | null;        // optional specific user_id; null = round-robin
}): Promise<{ assignedTo: string | null }>
```

## Minimal example

```ts
await handleEscalation({
  workspaceId,
  ticketId,
  reason: "Customer asked for human",
});
```

## Round-robin assignment

Default behavior: round-robin across active [[../tables/workspace_members]] in the `agent` role. Skips out-of-office members (if office hours config is on).

Pass `assignTo: userId` to target a specific agent — used when the customer was already in a conversation with someone.

## What it does

1. Picks `assignedTo` (round-robin or override).
2. Updates [[../tables/tickets]]:
   - `escalated_to = assignedTo`
   - `escalated_at = now()`
   - `escalation_reason = reason`
   - `status = 'open'` (escalated tickets stay open, NOT pending — see JOURNEYS.md)
3. Sends the holding message via `pending_send_at` (so the customer doesn't get instant double-replies).
4. Tags the ticket `escalated`.
5. Fires Slack notification if [[../tables/slack_notification_rules]] has an entry.

## Gotchas

- **Status stays `open`** — not `pending`. `pending` is for agent-sent messages waiting on customer reply.
- **Holding message defaults** to `workspaces.auto_close_reply` template or channel-specific copy. Override when context warrants.
- **Never promise "live agent connection"** in the holding message. Say "team will be in touch" — see feedback_no_live_agent_promise.
- **For chat channel, the holding message MUST mention** "I'll send you an email at {email}" — see SONNET-ORCHESTRATOR.md chat escalation rule.
- **Don't double-escalate.** If `escalated_to` is already set, skip the update (idempotency).

## Related

[[../libraries/escalation]] · [[../tables/tickets]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-multi-turn]]
