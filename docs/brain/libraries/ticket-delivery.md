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

### `resolvePlaceholderSafeMessage` — function

```ts
async function resolvePlaceholderSafeMessage(
  admin, workspaceId: string, ticketId: string,
  customerId: string | null, message: string,
) : Promise<string>
```

The placeholder guarantee at the send chokepoint ([[../specs/no-send-path-can-emit-an-unsubstituted-placeholder]]). Runs unconditionally at the top of `deliverTicketMessage` on every outbound customer message: (1) if the message references `{{label_url}}` / `[LABEL_URL]` and the ticket has a `customer_id`, looks up the customer's most-recent non-terminal `returns` row (`.eq('workspace_id', …).eq('customer_id', customerId).not('label_url','is',null).not('status','in','(refunded,cancelled,closed)').order('created_at', desc).limit(1)`) and substitutes with the same `ctaButton` render `substituteActionPlaceholders` uses; (2) any residual `{{token}}` / `[UPPER_TOKEN]` is stripped via [[action-executor|stripUnsubstitutedPlaceholders]] with a WARN naming the ticket id and the offending tokens. A composing caller (`substituteActionPlaceholders`, `cs-director` remedy fill, journey lead-in) MAY rely on this — a token it forgot to fill can never leak. Idempotent: a message the composer already filled has no matching tokens and this is a no-op safety net under it, not a replacement.

Bounded to the ticket's own `customer_id` — never crosses to another customer (spec: "Never guess across customers"). Exported so tests pin the guarantee without spinning up a live delivery (`src/lib/ticket-delivery.placeholder-guard.test.ts`, five cases).

## Why it exists

Built by [[../specs/improve-orchestrator-action-parity]] so an operator-approved Improve `orchestrator_action` reaches the customer through the SAME per-channel path the orchestrator uses ([[../orchestrator-tools]] § Improve parity · "identical ticket messages" invariant). It deliberately omits the orchestrator's pending/delay machinery — an operator already approved the action, so it delivers immediately.

## Callers

- [[improve-plan-executor]] — the `send` passed to `executeSonnetDecision` for `orchestrator_action`.

## Gotchas

- Mirrors (does not yet share code with) the `send()` helper in [[../inngest/unified-ticket-handler]] and `executeCustomerReply` in `agent-todos/execute.ts`. Those remain separate; this one is the only **portal-aware** copy. A future consolidation could make all three import this.
- `sms` / `meta_dm` channels only get the row inserted (no outbound API send here) — matching the orchestrator's `send()`, which also branches only email/portal/chat.
- **The placeholder-guarantee owner is the delivery chokepoint, not the composing caller** ([[../specs/no-send-path-can-emit-an-unsubstituted-placeholder]]). Before this rail moved, at least three send paths bypassed [[action-executor|substituteActionPlaceholders]] and customers read literal "{{label_url}}" — Ethel Hutton filed a BBB complaint over ticket `2305546a` and Julianne Peters spent 15 days without a usable label over ticket `de357c10`, both 2026-07-28..29. The strip now lives in `resolvePlaceholderSafeMessage` at the top of `deliverTicketMessage`, so a NEW composing path added tomorrow inherits the guarantee automatically — forgetting the helper is no longer possible.

---

[[../README]] · [[../../CLAUDE]]
