# Replacement Order Playbook — Full Spec

## Overview
Handles order replacements for delivery failures, missing/damaged items, and wrong-address situations. Creates $0 Shopify draft orders for replacement items, validates shipping addresses via EasyPost, and adjusts subscription billing dates.

---

## Replacement Rules

### Limits
| Scenario | Limit | Notes |
|---|---|---|
| Customer error (bad address, wrong address) | **1 replacement per customer, ever** | Track in `customer_events` or `replacements` table |
| Delivery error (carrier lost, damaged in transit) | **No limit** | Carrier's fault, always replace |
| Refused order | **Never replace** | Escalate to admin if customer asks |
| Missing/damaged items | **No limit** | Partial replacement (only missing items) |

### Qualification Check
Before issuing any replacement:
1. Query `replacements` table for prior customer-error replacements
2. If customer-error AND already has 1+ prior → deny, escalate to admin
3. If refused → deny, escalate to admin with note "Customer requesting replacement on refused order"
4. If delivery error / missing / damaged → proceed

---

## Playbook Steps

### Step 1: `identify_order`
- Find the customer's recent orders (last 21 days)
- Present order list for identification (same pattern as unwanted charge playbook)
- If triggered from delivery audit cron, order is pre-identified

### Step 2: `check_tracking`
- EasyPost lookup on the order's tracking number
- Determine scenario:
  - `delivered` → ask customer what happened (missing items? damaged? not received?)
  - `return_to_sender` + refused → deny replacement, escalate
  - `return_to_sender` + other → delivery error, proceed to address confirmation
  - `in_transit` → still moving, ask customer to wait
  - `failure` → carrier error, proceed to replacement

### Step 3: `classify_issue`
Based on customer response + tracking data:
- **Not received (but delivered)** — could be porch piracy, wrong door. 1 replacement allowed.
- **Missing items** → go to missing items journey (Step 4a)
- **Damaged items** → go to missing items journey with damage flag (Step 4a)
- **Wrong address** → customer error, 1 replacement limit applies
- **Carrier lost/failed** → delivery error, no limit

### Step 4a: `missing_items_journey` (Journey)
- Send customer a form with each item from the order (exclude Shipping Protection)
- Checklist: customer checks which items are missing/damaged
- Optional: photo upload for damaged items (future)
- Returns list of items to replace

### Step 4b: `confirm_address_journey` (Journey)
- Show current shipping address on file
- Customer can confirm or update
- **EasyPost address validation** on any new/updated address
  - `Address.createAndVerify()` with `verify_strict: true`
  - If verification fails → show suggested corrections, ask customer to confirm
  - If verification passes → proceed
- Updates:
  - Customer profile in Supabase (`customers.default_address` or `shipping_address`)
  - Appstle subscription shipping address (PUT endpoint)
  - Shopify customer address (GraphQL `customerAddressUpdate` or `customerUpdate`)

### Step 5: `create_replacement`
- Create Shopify draft order via `draftOrderCreate` GraphQL mutation:
  - Line items: only the items being replaced (from Step 4a, or full order)
  - `appliedDiscount`: 100% percentage discount ("Replacement — [reason]")
  - Shipping address: validated address from Step 4b
  - Note: "Replacement for [original order number] — [reason]"
  - Tags: `replacement`, `replacement:SC12345` (original order ref)
- `draftOrderComplete` to convert to real order
- Record in `replacements` table
- Internal note on ticket with replacement order details

### Step 6: `adjust_subscription`
- If the original order was from an active subscription:
  - Get subscription billing interval (e.g., 4 weeks, 8 weeks)
  - Set next billing date = today + interval
  - Via Appstle API: `PUT /subscription-contracts-update-next-billing-date`
- Notify customer: "Your next subscription shipment is now scheduled for [date]"

### Step 7: `close`
- Send confirmation: "Your replacement order has been created and will ship within 2-3 business days"
- Close ticket

---

## Shipping Address Journey

### Flow
```
Step 1: Show current address
  → "Is this the correct shipping address?"
  → [Yes, ship here] / [No, update address]

Step 2 (if updating): Address form
  - Name, Street 1, Street 2, City, State, ZIP, Country, Phone
  - Pre-filled with current address

Step 3: EasyPost validation
  - Call Address.createAndVerify({ ...address, verify_strict: true })
  - If success → proceed
  - If failed but has suggestion → show "Did you mean: [corrected address]?" → [Use suggested] / [Keep mine]
  - If failed no suggestion → "We couldn't verify this address. Please double-check and try again."

Step 4: Save
  - Update customer profile (Supabase)
  - Update Appstle subscription address
  - Update Shopify customer address
  - Confirm: "Address updated to [new address]"
```

### Channels
- Email: mini-site journey link
- Chat: inline form steps (same as other journeys)

---

## Missing Items Journey

### Flow
```
Step 1: Item checklist
  - Show each line item from the order (exclude "Shipping Protection")
  - Each item has: [checkbox] [product name] x[quantity]
  - "Select all items that were missing or damaged"

Step 2: Damage details (if any checked)
  - For each checked item: "Was this item missing or damaged?"
  - Radio: [Missing] [Damaged]
  - (Future: photo upload for damaged)

Step 3: Confirm
  - "We'll send replacements for: [list]"
  - → Proceeds to address confirmation + draft order
```

---

## Shopify Draft Order Creation

### GraphQL Mutation
```graphql
mutation draftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      order { id name }
    }
    userErrors { field message }
  }
}
```

### Input
```typescript
{
  input: {
    lineItems: items.map(item => ({
      variantId: `gid://shopify/ProductVariant/${item.variantId}`,
      quantity: item.quantity,
    })),
    appliedDiscount: {
      title: "Replacement — [reason]",
      valueType: "PERCENTAGE",
      value: 100,
    },
    shippingAddress: { /* validated address */ },
    note: "Replacement for SC12345 — [reason]",
    tags: ["replacement", "replacement:SC12345"],
    // email: customer email (sends confirmation)
  }
}
```

### Then complete:
```graphql
mutation draftOrderComplete($id: ID!) {
  draftOrderComplete(id: $id) {
    draftOrder { order { id name } }
    userErrors { field message }
  }
}
```

---

## Database

### `replacements` table (new)
```sql
CREATE TABLE replacements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  customer_id UUID REFERENCES customers(id),
  original_order_id UUID REFERENCES orders(id),
  original_order_number TEXT,
  replacement_order_id UUID REFERENCES orders(id),  -- links to synced Shopify order
  shopify_draft_order_id TEXT,
  shopify_replacement_order_id TEXT,
  reason TEXT NOT NULL,  -- refused, delivery_error, missing_items, damaged_items, wrong_address, carrier_lost
  reason_detail TEXT,    -- e.g. "Insufficient Address", specific items missing
  items JSONB,           -- [{title, variantId, quantity, type: "missing"|"damaged"}]
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, address_confirmed, created, shipped, completed, denied
  customer_error BOOLEAN NOT NULL DEFAULT false,  -- true if customer's fault (wrong address)
  ticket_id UUID REFERENCES tickets(id),
  address_validated BOOLEAN DEFAULT false,
  validated_address JSONB,
  subscription_adjusted BOOLEAN DEFAULT false,
  new_next_billing_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_replacements_workspace ON replacements(workspace_id);
CREATE INDEX idx_replacements_customer ON replacements(customer_id);
CREATE INDEX idx_replacements_status ON replacements(status);

-- RLS
ALTER TABLE replacements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workspace_read" ON replacements FOR SELECT USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
);
CREATE POLICY "service_all" ON replacements FOR ALL USING (auth.role() = 'service_role');
```

---

## UI

### Sidebar
```
Customers
  ├── All Customers
  ├── Orders
  ├── Returns
  ├── Replacements  ← NEW
  └── Subscriptions
```

### Replacements List Page (`/dashboard/replacements`)
- Table: Original Order, Customer, Reason, Status, Replacement Order, Items, Created
- Filters: status (pending/created/shipped/completed/denied), reason
- Click → detail view

### Replacements Widget (shared component)
Appears on:
- Customer detail page
- Ticket detail page
- Subscription detail page

Shows:
- List of replacements for this customer/ticket/subscription
- Status badge (pending/created/shipped/completed)
- Original order → Replacement order link
- Reason + detail

---

## Tags
- `replacement:requested` — customer asked for replacement
- `replacement:created` — draft order created
- `replacement:shipped` — replacement order fulfilled
- `replacement:denied` — replacement denied (refused order, limit reached)

---

## Implementation Order
1. Migration: `replacements` table
2. `src/lib/shopify-draft-orders.ts` — create + complete draft orders
3. `src/lib/easypost.ts` — add `verifyAddress()` function
4. Address confirmation journey definition + builder
5. Missing items journey definition + builder
6. Replacement playbook (playbook-executor steps)
7. API endpoints: `/api/workspaces/[id]/replacements` (CRUD + create-draft)
8. Sidebar + list page + detail page
9. Shared ReplacementsWidget component
10. Subscription date adjustment logic
