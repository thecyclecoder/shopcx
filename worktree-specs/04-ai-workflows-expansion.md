# Worktree: AI Workflows Expansion

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-ai-workflows feature/ai-workflows-expansion
cd ../shopcx-ai-workflows
npm install
```

Work in `/Users/admin/Projects/shopcx-ai-workflows` — NOT main.

## What to Build

Expand AI agent workflows to handle the most common ticket types beyond discount questions. Each workflow gives the AI the ability to take actions via Shopify/Appstle APIs when the customer confirms.

## Workflows to Build

### 1. Return/Exchange Request
**Trigger**: Customer mentions return, exchange, wrong item, damaged
**AI Flow**:
1. Look up most recent order
2. Ask what's wrong (wrong item, damaged, don't like it)
3. Based on reason, offer return instructions or exchange
4. Create a return label (if Shopify returns API available) or escalate to agent
5. Add tag `return-request`

**Actions**: Create internal note with return details, tag ticket, escalate if needed

### 2. Shipping Address Change
**Trigger**: Customer wants to change address on upcoming order/subscription
**AI Flow**:
1. Check if order is unfulfilled (can change) or fulfilled (can't)
2. If unfulfilled: ask for new address, confirm, update via Shopify GraphQL
3. If fulfilled: explain it's already shipped, provide tracking
4. For subscription: update default address via Appstle API

**Actions**:
- `updateShippingAddress()` from `src/lib/shopify-order-actions.ts` (built by order-actions worktree)
- Appstle address update API

### 3. Subscription Modification
**Trigger**: Customer wants to skip, swap product, change frequency
**AI Flow**:
1. Look up active subscriptions
2. Determine what they want: skip next order, swap a product, change frequency
3. Confirm the change
4. Execute via Appstle API

**Actions**:
- Skip: Appstle `subscription-contracts-skip` API
- Swap: Appstle `subscription-contracts-swap` API
- Frequency: Appstle `subscription-contracts-update-billing-interval` API

### 4. Order Status Inquiry (AI version)
**Trigger**: Customer asks where their order is (when no smart tag workflow catches it)
**AI Flow**:
1. Look up most recent order
2. Check fulfillment status
3. If unfulfilled: "Your order is being prepared"
4. If fulfilled: provide tracking info, carrier, delivery estimate
5. If delivered: confirm delivery date

**Actions**: Read-only, uses data from context (already available)

## Implementation Pattern

Each workflow is an `ai_workflows` row in the database + detection logic in the AI context.

### Database: Seed workflows
```sql
INSERT INTO ai_workflows (workspace_id, name, description, enabled, trigger_intent, match_patterns, match_categories, response_source, allowed_actions, config) VALUES
('WS_ID', 'Return Request', 'Handle return and exchange requests', true, 'return_request',
 ARRAY['return', 'exchange', 'wrong item', 'damaged', 'broken', 'not what I ordered', 'send back'],
 ARRAY['policy'], 'either', '["create_return"]', '{}'),
('WS_ID', 'Address Change', 'Update shipping address on orders or subscriptions', true, 'address_change',
 ARRAY['change address', 'update address', 'wrong address', 'moved', 'new address', 'shipping address'],
 ARRAY['shipping'], 'either', '["update_address"]', '{}'),
('WS_ID', 'Subscription Change', 'Skip, swap, or change subscription frequency', true, 'subscription_change',
 ARRAY['skip', 'swap', 'change frequency', 'every 2 weeks', 'every month', 'pause', 'hold'],
 ARRAY['subscription'], 'either', '["modify_subscription"]', '{}');
```

### Action Execution in Multi-Turn Handler

Add to `src/lib/inngest/ai-multi-turn.ts` execute-actions step:

For each workflow, detect confirmation and execute:
- **Address change**: Parse address from message, call Shopify mutation
- **Subscription skip**: Call Appstle skip API
- **Subscription swap**: Call Appstle swap API (need product selection)

### AI Context Updates (`src/lib/ai-context.ts`)

The available workflows are already loaded into the AI context. Just add clearer instructions:
```
- RETURN FLOW: If customer wants to return/exchange, ask what's wrong, then escalate to agent for processing. Do not promise refunds.
- ADDRESS FLOW: If customer wants to change address, ask for the new address. If order is unfulfilled, confirm and say you're updating it. If fulfilled, explain it's already shipped.
- SUBSCRIPTION FLOW: If customer wants to skip/swap/change frequency, confirm the change and say you're processing it.
```

## Files to Create/Modify
- Seed script or migration for new ai_workflows rows
- `src/lib/appstle.ts` — Add skip, swap, frequency change functions
- `src/lib/inngest/ai-multi-turn.ts` — Add action detection for new workflows
- `src/lib/ai-context.ts` — Add workflow-specific instructions

## Appstle API Endpoints Needed
- Skip: `PUT /api/external/v2/subscription-contracts-skip?contractId=X&api_key=X`
- Frequency: `PUT /api/external/v2/subscription-contracts-update-billing-interval?contractId=X&interval=WEEK&intervalCount=2&api_key=X`
- Address: Need to find the right endpoint from Appstle docs

## Testing
1. "I want to return my last order" → AI asks what's wrong → escalates
2. "Can you change my shipping address to 123 Main St?" → AI confirms → updates
3. "I want to skip my next subscription order" → AI confirms → skips via Appstle
4. "Where is my order?" → AI provides tracking info

## When Done
Push to `feature/ai-workflows-expansion` branch. Tell the merge manager (main terminal) to merge.
