# Playbook System — Full Spec

## Overview

Playbooks are structured decision trees that guide both AI and human agents through complex customer issues. They combine deterministic policy logic with AI-generated communication, ensuring consistent resolution regardless of who handles the ticket.

**Location:** Settings → Playbooks (own settings card, not under AI)

---

## Data Model

### 1. `playbooks` table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| workspace_id | UUID FK | |
| name | TEXT | e.g., "Unwanted Charge / Subscription Dispute" |
| description | TEXT | Admin-facing summary |
| trigger_intents | TEXT[] | Intents that activate this playbook: `["unwanted_charge", "subscription_dispute", "refund_request"]` |
| trigger_patterns | TEXT[] | Keyword patterns (like journey match_patterns): `["charged without permission", "didn't sign up", "unauthorized charge"]` |
| priority | INTEGER | Higher = runs first when multiple match |
| is_active | BOOLEAN | Enable/disable |
| exception_limit | INTEGER DEFAULT 1 | Max exceptions per playbook execution |
| stand_firm_max | INTEGER DEFAULT 3 | Max "stand firm" repetitions before AI stops |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 2. `playbook_policies` table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| workspace_id | UUID FK | |
| playbook_id | UUID FK | |
| name | TEXT | e.g., "30-Day Money Back Guarantee" |
| description | TEXT | Full policy text (AI reads this to explain to customer) |
| conditions | JSONB | Structured eligibility: `{ "days_since_delivery": { "<=": 30 }, "product_type": { "in": ["physical"] } }` |
| ai_talking_points | TEXT | How to explain the policy without sounding robotic |
| sort_order | INTEGER | |

### 3. `playbook_exceptions` table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| workspace_id | UUID FK | |
| playbook_id | UUID FK | |
| policy_id | UUID FK | Which policy this is an exception to |
| tier | INTEGER | 1 = first offer, 2 = escalated offer, etc. |
| name | TEXT | e.g., "Return for Store Credit" |
| conditions | JSONB | Customer eligibility: `{ "or": [{ "ltv_cents": { ">=": 30000 } }, { "total_orders": { ">=": 3 } }] }` |
| resolution_type | TEXT | `store_credit_return`, `refund_return`, `store_credit_no_return`, `refund_no_return` |
| instructions | TEXT | AI guidance: "Lead with the store credit option. Frame it as a benefit — credit never expires." |
| sort_order | INTEGER | |

**Auto-granted exceptions** (system errors — no customer eligibility check needed):

| Column | Type | Description |
|--------|------|-------------|
| auto_grant | BOOLEAN DEFAULT false | If true, skip conditions — always grant |
| auto_grant_trigger | TEXT | `duplicate_charge`, `cancelled_but_charged`, `never_delivered` |

### 4. `playbook_steps` table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| workspace_id | UUID FK | |
| playbook_id | UUID FK | |
| step_order | INTEGER | Execution sequence |
| type | TEXT | See step types below |
| name | TEXT | Admin label: "Identify the order" |
| instructions | TEXT | AI communication guidance for this step |
| data_access | TEXT[] | What data to fetch: `["recent_orders", "subscriptions", "customer_events"]` |
| resolved_condition | TEXT | What makes this step complete: `order_identified`, `policy_explained`, `exception_offered` |
| config | JSONB | Step-type-specific config |
| skippable | BOOLEAN DEFAULT true | Can AI skip if already answered |

**Step Types:**

| Type | Purpose | Config |
|------|---------|--------|
| `identify_order` | Match complaint to specific order(s) | `{ "lookback_days": 60 }` |
| `identify_subscription` | Find related subscription(s) | `{ "check_all_active": true }` |
| `check_other_subscriptions` | Proactively check for other active subs | |
| `apply_policy` | Evaluate order(s) against policy conditions | `{ "policy_id": "uuid" }` |
| `offer_exception` | Check eligibility, offer tiered resolution | `{ "policy_id": "uuid" }` |
| `initiate_return` | Create Shopify return | `{ "pre_check_eligibility": true }` |
| `explain` | Deliver information/context to customer | |
| `stand_firm` | Handle rejection of all offers | `{ "max_repetitions": 3 }` |
| `cancel_subscription` | Cancel via Appstle | |
| `issue_store_credit` | Issue store credit | `{ "amount_source": "order_total" }` |
| `custom` | Free-form AI instruction step | |

### 5. Ticket fields (additions)

| Column | Type | Description |
|--------|------|-------------|
| active_playbook_id | UUID FK nullable | Currently executing playbook |
| playbook_step | INTEGER DEFAULT 0 | Current step in active playbook |
| playbook_queue | JSONB DEFAULT '[]' | Array of queued playbook IDs |
| playbook_context | JSONB DEFAULT '{}' | Accumulated data: identified orders, applied exceptions, etc. |
| playbook_exceptions_used | INTEGER DEFAULT 0 | Count of exceptions granted in this execution |

### 6. Notification settings

| Column | Type | Description |
|--------|------|-------------|
| Add to workspace notification_settings JSONB | | |

**Default notification config:**
```json
{
  "playbook_api_failure": {
    "enabled": true,
    "channels": ["slack"],
    "notify_roles": ["owner"],
    "editable": true
  }
}
```

Sends Slack notification on any API failure during playbook execution:
- Which playbook + step failed
- Customer name + email
- Error message
- Link to ticket
- Default: ON, notify owners. Editable in Settings → Notifications.

---

## Playbook Execution (inside unified handler)

### Where it fits in the pipeline

The unified handler's routing step (step 9) gains a new priority level:

```
Route by Priority:
1. Journey (trigger_intent or match_patterns)
2. Playbook (trigger_intents or trigger_patterns)  ← NEW
3. Workflow (trigger_tag)
4. Macro (embeddings)
5. KB Article (RAG)
6. Escalate
```

### Execution flow

```
Playbook matched → set active_playbook_id on ticket
  ↓
For each step (starting from playbook_step):
  ↓
  1. Re-fetch live customer data (orders, subs, events)
  2. Check timeline changes (events since ticket created)
  3. Check if step can be skipped (already answered in customer message)
  4. If not skippable → execute step:
     a. Run step logic (query data, evaluate conditions)
     b. Generate AI response using step instructions + data
     c. Log system note: "[Playbook] Step N: {name} — {result}"
     d. Check resolved condition
        - Resolved → advance playbook_step, continue
        - Not resolved → send response, wait for customer reply
  5. Store accumulated data in playbook_context
  ↓
Customer replies → unified handler detects active_playbook_id
  → skips journey/workflow/macro matching
  → goes directly to playbook executor at current step
  → re-evaluates with new message
  ↓
All steps complete → clear active_playbook_id
  → check playbook_queue for next playbook
  → if queue has items → start next (check preconditions first)
  → if queue empty → close ticket
```

### Multi-order handling

When `identify_order` step resolves to multiple orders:
1. Evaluate ALL orders against policy
2. Separate into: in-policy (eligible), exception-eligible, not-eligible
3. Apply exception limit (max per execution, configurable on playbook)
4. Exception applied to most recent non-qualifying order
5. Generate ONE consolidated response covering all orders

### Tangent handling

During playbook execution, if customer asks something off-topic:
- **KB/macro answerable** → answer inline, steer back to current step
- **New issue requiring playbook** → add to `playbook_queue`, acknowledge: "Let me finish resolving this first, then we'll look into that"
- **Escalation trigger** (asks for human) → AI explains it's handling this, continues playbook

### Stand firm behavior

When customer rejects all policy + exception offers:
1. AI acknowledges frustration, restates the best available offer
2. Each repetition uses different wording (not verbatim repeat)
3. After `stand_firm_max` (default 3) repetitions:
   - Send final message: "I understand this is frustrating. My best offer is [offer]. If you change your mind, just reply and we'll get it started."
   - Set ticket to pending
   - AI stops responding to this ticket
   - Don't close — customer can come back

### Stale data handling

Every step re-fetches live data. If state changed since last AI message:
- Compare `customer_events` timestamps with last AI message timestamp
- If subscription/order status changed → acknowledge: "Since we last spoke, I can see your subscription was cancelled on [date]"
- Playbook can auto-resolve steps based on changed state

---

## Return Flow Integration

### Shopify Returns API flow

```
1. AI pre-checks return eligibility (before offering)
   → Query order fulfillments for returnability
   → If not eligible → escalate to human agent + Slack notification

2. Customer accepts return offer
   → returnCreate mutation (status: OPEN)
   → Shopify sends customer return instructions email
   → System note: "[Playbook] Return created for order #SC12345"

3. Customer ships product back
   → We ask for tracking number in follow-up
   → Store tracking on return record

4. Track return delivery
   → Poll carrier API or wait for Shopify webhook
   → When delivered → trigger resolution

5. Auto-issue resolution
   → Store credit: use existing store-credit/issue endpoint
   → Refund: use Shopify returnProcess mutation
   → System note: "[Playbook] Issued $XX store credit for order #SC12345"
   → Send confirmation email to customer
   → Close ticket
```

### Returns dashboard (sidebar item below Orders)

New page: `/dashboard/returns`

| Column | Description |
|--------|-------------|
| Order # | Link to order |
| Customer | Name + email |
| Status | Requested → Approved → Shipped → Delivered → Resolved |
| Resolution | Store Credit / Refund / Pending |
| Amount | Dollar amount |
| Tracking | Carrier + number |
| Source | AI Playbook / Customer Portal / Manual |
| Created | Date |

- Customer-initiated returns (from Shopify) flagged for human review
- AI-initiated returns show which playbook triggered them
- Filter by status, resolution type, source

### Shopify webhooks needed

- `returns/create` — new return created (customer or AI)
- `returns/update` — status change
- `reverse_fulfillment_orders/dispose` — item received at warehouse

---

## Settings UI

### Settings → Playbooks

**List view:** Cards showing each playbook with name, trigger intents, priority (drag to reorder), active toggle, success metrics

**Detail view (click into a playbook):**

**Header:** Name, description, active toggle

**Trigger section:**
- Intent tags (multi-select): unwanted_charge, refund_request, etc.
- Pattern keywords (tag input): "charged without permission", "didn't sign up"

**Policy section:**
- List of linked policies with conditions
- Each policy expandable to show conditions + AI talking points

**Exceptions section:**
- Tiered list per policy
- Each tier: name, conditions (visual builder), resolution type, instructions
- Auto-grant exceptions with trigger type

**Steps section:**
- Ordered list of step cards (drag to reorder)
- Each card: type dropdown, name, instructions textarea, config fields
- Add/remove steps

**Settings:**
- Exception limit per execution (number input)
- Stand firm max repetitions (number input)

**Simulate button:**
- Opens modal: pick customer (searchable dropdown), enter sample message
- Sonnet runs through each step showing:
  - What data it found
  - What condition evaluated to
  - What AI would say
  - Warnings about missing scenarios

---

## Default Playbooks (seeded for Superfoods Company)

### Playbook 1: "Unwanted Charge / Subscription Dispute"

**Triggers:** `unwanted_charge`, `subscription_dispute`, `charged_without_permission`
**Patterns:** "charged without permission", "didn't sign up for subscription", "unauthorized charge", "charged me again", "stop charging me"

**Policy:** 30-Day Return Policy
- Conditions: `days_since_fulfillment <= 30 AND product_type = "physical"`

**Exceptions:**
- Auto-grant: `cancelled_but_charged` (system error — refund without return)
- Tier 1: `LTV >= $300 OR total_orders >= 3` → Return for store credit
- Tier 2: Customer rejects tier 1 → Return for refund

**Steps:**
1. `identify_order` — "Find their recent orders. If multiple, ask which one. If they say 'all of them,' resolve to array."
2. `identify_subscription` — "Find the subscription that generated the order. Note creation date and renewal count."
3. `check_other_subscriptions` — "Check for other active subscriptions proactively. Customer might not know about them."
4. `apply_policy` — "Explain what happened neutrally. 'Your subscription was created on [date], this was the automatic renewal.' Never accusatory."
5. `offer_exception` — "If in policy, offer return. If not, check exception eligibility. Lead with store credit. If rejected, offer refund option."
6. `initiate_return` — "Pre-check Shopify eligibility. Create return. Let customer know they'll receive instructions via email."
7. `cancel_subscription` — "Cancel the subscription via Appstle. Confirm no other active subs, or offer to cancel those too."
8. `stand_firm` — "If all offers rejected, acknowledge frustration. Restate best offer. Never argue, never cave beyond tiers."

### Playbook 2: "Missing / Lost Order"

**Triggers:** `missing_order`, `order_not_received`, `lost_package`
**Patterns:** "never received", "where is my order", "package lost", "tracking shows delivered but"

**Steps:**
1. `identify_order` — "Find the order they're asking about."
2. `explain` — "Look up fulfillment + tracking data. Share tracking status with customer."
3. `apply_policy` — "If tracking shows delivered, explain. If lost in transit, offer replacement or store credit."
4. `initiate_return` — "For 'delivered but not received,' file carrier claim or send replacement."

---

## API Failure → Slack Notification

When any playbook action step fails (Shopify return, Appstle cancel, store credit issue):

**Slack message format:**
```
🚨 Playbook Action Failed

Playbook: Unwanted Charge / Subscription Dispute
Step: Initiate Return (step 6)
Customer: Elvi Lamping (elviexpress@gmail.com)
Error: Shopify returnCreate failed: Order not eligible for return
Ticket: https://shopcx.ai/dashboard/tickets/{id}

Action needed: Manual return processing required.
```

**Notification settings** (Settings → Notifications):
- Default: ON
- Default recipients: owners
- Editable: can add specific team members, change to all agents, etc.
- Channel: Slack (expandable to email later)

---

## Migration Plan

### New tables
- `playbooks`
- `playbook_policies`
- `playbook_exceptions`
- `playbook_steps`

### Ticket alterations
- Add: `active_playbook_id`, `playbook_step`, `playbook_queue`, `playbook_context`, `playbook_exceptions_used`

### New webhook subscriptions
- `returns/create`
- `returns/update`
- `reverse_fulfillment_orders/dispose`

### Settings
- New "Playbooks" card in Settings (Ticketing & AI section)
- New "Returns" sidebar nav item (below Orders)
- Notification default for `playbook_api_failure`

### Unified handler changes
- Add playbook routing at priority 2 (after journeys, before workflows)
- Add playbook executor (called from handler, not separate function)
- Playbook-active tickets skip normal routing, go straight to executor
