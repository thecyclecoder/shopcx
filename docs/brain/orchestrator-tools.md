# orchestrator-tools

What Sonnet can DO when handling a ticket. Two layers:

1. **Data tools** — read-only fetchers Sonnet calls on demand during deliberation (Pass-1: tool_use loop). Each returns formatted text it can reason over.
2. **Direct actions** — write mutations the action-executor runs after Sonnet returns its `SonnetDecision`.

This page is the agent-readable catalog. The runtime source of truth is `buildToolDefinitions()` in `src/lib/sonnet-orchestrator-v2.ts` (tools) + `directActionHandlers` in `src/lib/action-executor.ts` (actions).

## Data tools — what Sonnet can read

Sonnet decides which to call based on the customer message. Minimal pre-context is loaded; everything else is on-demand to keep the model focused.

| Tool | When Sonnet calls it | What it returns |
|---|---|---|
| `get_customer_account` | Account questions (subs, orders, billing, loyalty) | Subscriptions, last 3 orders, loyalty points + unused coupons, linked accounts, grandfathered-pricing detection |
| `get_customer_timeline` | "When did X happen?" / sequence-of-events questions | Chronological `customer_events` log — portal actions, sub mutations, journey responses |
| `get_product_knowledge` | Product / policy questions | Product catalog + descriptions, all macros with body text, KB article matches via RAG |
| `get_returns` | Return / exchange / refund status | Return requests with status, items, tracking, refund amount |
| `get_fraud_cases` | Fraud-flag questions or when behavior looks suspicious | Fraud case rows, severity, rule that triggered |
| `get_crisis_status` | Crisis tags on ticket or OOS mentions | Crisis tier responses, swap options, coupon info, pause/remove status |
| `get_chargebacks` | Disputes, unauthorized charges | Chargeback events with reason, status, amount |
| `get_email_history` | "Didn't receive email" questions | Last 10 email events with open/click/bounce status |
| `get_dunning_status` | Payment failures, billing issues | Dunning cycles, payment failure attempts |
| `get_payment_methods` | "Update my card", payment method questions | Payment methods from Shopify, deduped by last4+expiry |

Pre-loaded context (no tool call needed): customer name + email, ticket tags (includes crisis tags), conversation history (last 8 messages + action completion notes), available handler names (journeys, playbooks, workflows), AI personality.

Two-bucket reasoning: account question → `get_customer_account` first; product/policy question → `get_product_knowledge` first. If first bucket doesn't have the answer → try the other. If neither → escalate (genuine knowledge gap).

## Direct actions — what Sonnet can do

Sonnet returns `{action_type, actions: [...]}` with the action type and params; the action-executor dispatches via `directActionHandlers`. Per the [[operational-rules]] § Orchestrator discipline rule, **Sonnet returns IDs only** — hardcoded code paths fetch + validate + execute.

### Subscription mutations
- `pause` — pause indefinitely
- `pause_timed` — pause + schedule resume via [[inngest/portal-auto-resume]]
- `resume` — un-pause active
- `skip_next_order` — advance `next_billing_date` by one cycle
- `change_frequency` — update billing interval
- `change_next_date` — set explicit next billing date
- `bill_now` — fire an immediate Appstle billing attempt
- `reactivate` — reactivate a cancelled sub
- `add_item` / `remove_item` / `swap_variant` / `change_quantity` — line-item mutations
- `update_line_item_price` — price override (see [[recipes/change-line-item-price]] for the 25% Subscribe-&-Save baked-in math)
- `apply_coupon` / `remove_coupon` — discount management
- `apply_loyalty_coupon` — apply a previously-redeemed loyalty code

### Order mutations
- `partial_refund` — Shopify partial refund (or Braintree-direct fallback for the new internal-checkout path)
- `create_return` — initiate a return via [[lifecycles/return-pipeline]] (EasyPost label + `returns` row)
- `create_replacement_order` — free draft order, $0 via 100% PERCENTAGE discount
- `update_shipping_address` — update address on a pending order

### Loyalty
- `redeem_points` — spend points to generate a Shopify discount code
- `redeem_points_as_refund` — apply points value as a refund instead of a coupon

### Customer
- `update_customer_info` — name / phone / email updates
- `link_account_by_email` — confirm an account link
- `reject_account_link` — record a customer-rejected link suggestion (never re-offer)
- `unsubscribe_email_marketing` / `unsubscribe_sms_marketing` / `unsubscribe_all_marketing` — marketing consent flips via Shopify
- `marketing_signup` — sign up for email + SMS marketing

### Payment
- `switch_payment_method` — change the default card on a sub
- (new-card recovery is webhook-driven; see [[lifecycles/dunning]])

### Crisis (see [[lifecycles/crisis-campaign]])
- `crisis_pause` — pause sub due to crisis (auto-resume on resolution)
- `crisis_remove` — remove the affected item but keep the sub running
- `crisis_enroll` — enroll a sub in an active crisis campaign
- `crisis_set_auto_readd` — toggle the auto-readd-on-resolution flag

### Ticket
- `close_ticket` — explicit close (e.g. OOO auto-reply handling); `_closedThisRun` flag set so the post-execute path doesn't reopen
- `deactivate_ticket` — soft-deactivate (used for system-generated tickets that don't need a human reply)

### Action types vs handler dispatch

`SonnetDecision.action_type` is one of:
- `direct_action` — execute the actions array immediately (above handlers)
- `journey` — launch a journey by name OR trigger_intent
- `playbook` — start a playbook (lookup by name OR trigger_intents)
- `workflow` — run a workflow (lookup by name OR trigger_tag OR template)
- `macro` — send Sonnet's personalized macro response
- `kb_response` / `ai_response` — send Sonnet's generated response
- `escalate` — assign to agent, send holding message

Per the [[operational-rules]] § Orchestrator discipline rule, the **confirmed-fraud gate runs BEFORE the orchestrator** — any matched customer with `fraud_cases.status='confirmed_fraud'`, an `amazon_reseller` flag, or a known-reseller address short-circuits to escalate before any of the above fires.

## Related

[[lifecycles/ai-multi-turn]] · [[lifecycles/ticket-lifecycle]] · [[libraries/sonnet-orchestrator-v2]] · [[libraries/action-executor]] · [[customer-voice]] · [[operational-rules]] · [[tables/sonnet_prompts]] · [[recipes/change-line-item-price]] · [[recipes/issue-replacement]]
