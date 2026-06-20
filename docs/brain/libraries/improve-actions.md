# libraries/improve-actions

Improve-tab actions for agent overrides on playbook tickets.

**File:** `src/lib/improve-actions.ts`

## File header

```
Improve-tab action dispatcher. Used by both:
- The Opus loop in /api/tickets/[id]/improve (when admin hasn't yet
approved a proposal)
- The fast-path "execute_actions" body field (when admin clicks
Approve & Execute — bypasses Opus to avoid the "Opus forgot the
JSON it emitted last turn" failure mode)
Returns the result strings + the action context (label_url, etc.)
accumulated across the batch so chained send_message can substitute
placeholders.
```

## Exports

### `runImproveActions` — function

```ts
async function runImproveActions(workspaceId: string, ticketId: string, actions: ImproveAction[],) : Promise<ImproveActionResult>
```

### `ImproveAction` — interface

### `ImproveActionResult` — interface

## Callers

- `src/app/api/tickets/[id]/improve/route.ts`

## One customer-action code path (no drift)

The subscription / refund / coupon / price / marketing direct-action cases delegate to the orchestrator's `directActionHandlers` registry ([[action-executor]]) via the internal `dispatchDirectAction` helper — the SAME execution the conversation orchestrator runs. This kills the drift the [[../specs/improve-orchestrator-action-parity|parity spec]] was filed for (CLAUDE.md North star + "identical ticket messages"). `dispatchDirectAction` resolves the ticket's customer/channel, maps an internal subscription UUID → Shopify `contract_id`, and wraps the handler in `withActionContext` for per-action Appstle call logging. `captureContext` pulls customer-facing result fields (`refund_amount`, `label_url`, `tracking_number`, `carrier`, `coupon_code`) into `actionContext` so a chained `send_message` can still substitute them.

**Kept bespoke (deliberately NOT delegated):**
- `create_return` — ticket-aware order lookup (by `shopify_order_id` *or* `order_number`) + `source: "agent"`; the registry handler is `order_number`-only / `source: "ai"`.
- `pause` (indefinite) — the registry `pause` handler only supports 30/60-day timed pauses; Improve allows an open-ended pause.
- `cancel` — no registry direct handler (production routes cancellation through the cancel *journey*; for that, use an `orchestrator_action` with `action_type:"journey"`).
- `send_message`, `propose_sonnet_prompt`, `propose_grader_rule`, `close_ticket`, `reopen_ticket` — not customer-subscription mutations.
- `reassign_ticket_customer` `{to_customer_id, reason}` + `send_magic_link` `{}` — **Improve-only** account-repair pair (no Sonnet-runtime equivalent; the duplicate/typo'd-account login mess, Mindy Freeman `a89dcf76`). `reassign_ticket_customer` validates the target customer is in-workspace, re-points `tickets.customer_id`, and records a from→to internal note. `send_magic_link` mints a 24h link via `generateMagicLinkURL` for the ticket's **current** customer and emails it to that customer's **on-file address only** (no free-text recipient) — pair it *after* the reassign in one plan. See [[../specs/improve-account-fix-actions|account-fix spec]].

For anything beyond a direct action (launch a journey/playbook/workflow/macro, escalate), the box uses the `orchestrator_action` plan kind instead → [[improve-plan-executor]] → `executeSonnetDecision`. See [[../orchestrator-tools]] § Improve parity.

## Gotchas

- Migrating to the shared registry slightly changed some result strings (now prefer the handler's `summary`) — cosmetic, surfaced on the approval card / internal note.

---

[[../README]] · [[../../CLAUDE]]
