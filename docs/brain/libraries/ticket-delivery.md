# libraries/ticket-delivery

Deliver ONE outbound customer-facing message on a ticket's channel, the way production does it — the **portal-aware** per-channel send sink the Improve executor hands to `executeSonnetDecision`.

**File:** `src/lib/ticket-delivery.ts`

## Exports

### `deliverTicketMessage` — function

```ts
async function deliverTicketMessage(
  admin, workspaceId: string, ticketId: string,
  channel: string, message: string, sandbox: boolean,
): Promise<void>
```

Inserts an outbound `external`/`ai` `ticket_messages` row and delivers it on `channel`:
- **email** → [[email|sendTicketReply]] (threaded via `email_message_id`), stamps `resend_email_id`/`email_status`.
- **portal** → [[../integrations/resend|sendPortalThreadEmail]] — **the gap this fixes**: the old `improve-actions` `send_message` only emailed when `channel==='email'`, so a portal customer never got the mail. Mirrors the orchestrator's `send()`.
- **chat** → row is delivered by the widget poll; if the chat customer has gone idle ([[delivery-channel|getDeliveryChannel]] → `email`) it also emails and threads the `email_message_id` back.
- **sandbox** → logs an `[AI Draft]` internal note, sends nothing.

Renders the body the same way the orchestrator does: `toHtml` paragraph shaping → `translateIfNeeded` (to `tickets.detected_language`) → `renderLabelUrlsAsButtons` ([[label-cta]]) so a bare return-label URL becomes a CTA button.

## Why it exists

Built by [[../specs/improve-orchestrator-action-parity]] so an operator-approved Improve `orchestrator_action` reaches the customer through the SAME per-channel path the orchestrator uses ([[../orchestrator-tools]] § Improve parity · "identical ticket messages" invariant). It deliberately omits the orchestrator's pending/delay machinery — an operator already approved the action, so it delivers immediately.

## Callers

- [[improve-plan-executor]] — the `send` passed to `executeSonnetDecision` for `orchestrator_action`.

## Gotchas

- Mirrors (does not yet share code with) the `send()` helper in [[../inngest/unified-ticket-handler]] and `executeCustomerReply` in `agent-todos/execute.ts`. Those remain separate; this one is the only **portal-aware** copy. A future consolidation could make all three import this.
- `sms` / `meta_dm` channels only get the row inserted (no outbound API send here) — matching the orchestrator's `send()`, which also branches only email/portal/chat.

---

[[../README]] · [[../../CLAUDE]]
