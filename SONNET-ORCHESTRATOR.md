# Sonnet Orchestrator

## Overview
The Sonnet orchestrator is the brain of ShopCX's AI agent. Every inbound customer message passes through it. Sonnet analyzes the message, decides the best action, and either executes directly or routes to the appropriate handler (journey, playbook, workflow, macro, KB).

## Architecture (v2 — Tool Use)

### How it works
Sonnet gets minimal pre-loaded context (~300 tokens) plus a catalog of data tools it can call on demand. It reasons about what data it needs, fetches it, then makes its decision.

### Pre-loaded context (always present)
- Customer name + email
- Ticket tags (includes crisis tags)
- Conversation history (last 8 messages + action completion notes)
- Available handler names: journeys, playbooks, workflows (names + trigger_intents)
- AI personality (tone, sign-off, channel)

### On-demand tools (Sonnet calls when needed)

| Tool | When to use | Data returned |
|---|---|---|
| `get_customer_account` | Account questions (subs, orders, billing, loyalty) | Subscriptions, last 3 orders, loyalty points + unused coupons, linked accounts, grandfathered pricing detection |
| `get_product_knowledge` | Product/policy questions | Product catalog + descriptions, all macros with body text, KB article matches via RAG |
| `get_returns` | Return/exchange/refund status | Return requests with status, items, tracking, refund amount |
| `get_crisis_status` | Crisis tags on ticket or OOS mentions | Crisis tier responses, swap options, coupon info, pause/remove status |
| `get_chargebacks` | Disputes, unauthorized charges | Chargeback events with reason, status, amount |
| `get_email_history` | "Didn't receive email" questions | Last 10 email events with open/click/bounce status |
| `get_dunning_status` | Payment failures, billing issues | Dunning cycles, payment failure attempts |

### Two-bucket reasoning
1. Account question → call `get_customer_account` first
2. Product/policy question → call `get_product_knowledge` first
3. If first bucket doesn't have the answer → try the other
4. If neither → genuine knowledge gap → escalate

### Decision output
Sonnet returns a `SonnetDecision` JSON — same interface regardless of v1 or v2:
```json
{
  "reasoning": "brief explanation",
  "action_type": "direct_action | journey | playbook | workflow | macro | kb_response | ai_response | escalate",
  "actions": [{ "type": "...", "contract_id": "...", ... }],
  "handler_name": "name of journey/playbook/workflow",
  "response_message": "message to send customer",
  "needs_clarification": false,
  "clarification_question": null
}
```

### Action executor
The `action-executor.ts` receives the `SonnetDecision` and dispatches:
- **direct_action** → executes subscription/loyalty/coupon operations directly
- **journey** → looks up by name OR trigger_intent, launches via `launchJourneyForTicket()`
- **playbook** → looks up by name OR trigger_intents, starts via `startPlaybook()`
- **workflow** → looks up by name OR trigger_tag OR template, runs via `executeWorkflow()`
- **macro** → sends Sonnet's personalized response
- **kb_response / ai_response** → sends Sonnet's generated response
- **escalate** → assigns to agent, sends holding message

## Key rules (DB-driven via `sonnet_prompts` table)
Rules are stored in `sonnet_prompts` and loaded at runtime. Editable at Settings → AI → Prompts. Key rules include:
- Cancel requests → always route to cancel journey (never cancel directly)
- Refunds → route to playbook (except price discrepancies — direct partial_refund)
- Simple subscription changes (skip, date, frequency, swap) → execute directly
- Save actions = just do it (don't ask). Cancel = route to journey.
- Loyalty: check unused coupons first → redeem if needed → give code → ask about applying
- One coupon per subscription — never stack
- Grandfathered pricing: no sale coupons below 50% floor, loyalty always OK
- Crisis: auto-fetch crisis status, berry_only → pause, berry_plus → remove OOS item
- Phone support: redirect ("not available, but I can help right here")
- Chat escalation: always include "I'll send you an email at {email}"
- Never fake confirmations — don't say "cancelled" without actually cancelling
- Never tell customers an action was done unless Action completed note confirms it

## Files

| File | Purpose |
|---|---|
| `src/lib/sonnet-orchestrator-v2.ts` | v2 with tool_use (shadow mode) |
| `src/lib/sonnet-orchestrator.ts` | v1 pre-loaded context (currently live) |
| `src/lib/action-executor.ts` | Executes SonnetDecision — direct actions, routing, response sending |
| `src/lib/inngest/unified-ticket-handler.ts` | Wiring — calls orchestrator, executes decision |

## Adding a new data tool

When you create a new table with `customer_id`:
1. Add a tool function in `sonnet-orchestrator-v2.ts` (fetches data, formats as text)
2. Add it to `buildToolDefinitions()` with a clear description
3. Add the case to `executeToolCall()` switch
4. Update this documentation
5. Update `CLAUDE.md` to note the new customer_id table

## Handler lookup rules
Sonnet may return any of these as `handler_name` — the executor checks all:
- **Journeys**: name, trigger_intent (case-insensitive)
- **Playbooks**: name, any trigger_intents[] entry (case-insensitive)
- **Workflows**: name, trigger_tag, template (case-insensitive)
