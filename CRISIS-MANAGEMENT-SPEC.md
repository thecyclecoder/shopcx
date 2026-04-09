# Crisis Management — Full Spec

## Overview
Proactive retention campaign system for out-of-stock (or other crisis) situations. Automatically contacts affected subscribers with a tiered offer sequence before their next order ships, tracks responses, and handles auto-resume/re-add when the crisis resolves.

---

## Session 1: Foundation (DB + Settings UI + Crisis CRUD)

### Database Schema

#### `crisis_events`
```sql
id UUID PRIMARY KEY
workspace_id UUID NOT NULL REFERENCES workspaces(id)
name TEXT NOT NULL                          -- "Mixed Berry Out of Stock"
status TEXT NOT NULL DEFAULT 'draft'        -- draft, active, paused, resolved
affected_variant_id TEXT NOT NULL           -- Shopify variant ID
affected_sku TEXT                           -- e.g. "SC-TABS-BERRY"
affected_product_title TEXT                 -- "Superfood Tabs — Mixed Berry"
default_swap_variant_id TEXT               -- auto-swap to this variant
default_swap_title TEXT                     -- "Superfood Tabs — Strawberry Lemonade"
available_flavor_swaps JSONB DEFAULT '[]'  -- [{variantId, title}] for Tier 1 journey
available_product_swaps JSONB DEFAULT '[]' -- [{variantId, title, productTitle}] for Tier 2 journey
tier2_coupon_code TEXT                      -- Shopify coupon code for Tier 2 (20% off)
tier2_coupon_percent INTEGER DEFAULT 20
expected_restock_date DATE
lead_time_days INTEGER DEFAULT 7           -- days before next_billing_date to send Tier 1
tier_wait_days INTEGER DEFAULT 3           -- days to wait between tier rejections
created_at TIMESTAMPTZ DEFAULT now()
updated_at TIMESTAMPTZ DEFAULT now()
```

#### `crisis_customer_actions`
```sql
id UUID PRIMARY KEY
crisis_id UUID NOT NULL REFERENCES crisis_events(id)
workspace_id UUID NOT NULL
subscription_id UUID REFERENCES subscriptions(id)
customer_id UUID REFERENCES customers(id)
segment TEXT NOT NULL                       -- 'berry_only' or 'berry_plus'
original_item JSONB                         -- {title, sku, variantId, quantity} — what was swapped/removed
current_tier INTEGER DEFAULT 0             -- 0=not started, 1=tier1 sent, 2=tier2 sent, 3=tier3 sent
tier1_sent_at TIMESTAMPTZ
tier1_response TEXT                         -- 'accepted_swap', 'rejected', null (pending)
tier1_swapped_to JSONB                     -- {variantId, title} if they picked a flavor
tier2_sent_at TIMESTAMPTZ
tier2_response TEXT                         -- 'accepted_swap', 'rejected', null
tier2_swapped_to JSONB                     -- {variantId, title, quantity} if they picked a product
tier2_coupon_applied BOOLEAN DEFAULT false
tier3_sent_at TIMESTAMPTZ
tier3_response TEXT                         -- 'accepted_pause', 'accepted_remove', 'rejected'
paused_at TIMESTAMPTZ                      -- when sub was paused (berry_only Tier 3)
auto_resume BOOLEAN DEFAULT false          -- unpause when crisis resolved
removed_item_at TIMESTAMPTZ               -- when item was removed (berry_plus Tier 3)
auto_readd BOOLEAN DEFAULT false           -- re-add item when crisis resolved
cancelled BOOLEAN DEFAULT false
cancel_date TIMESTAMPTZ
ticket_id UUID REFERENCES tickets(id)      -- ticket created for this customer's crisis
created_at TIMESTAMPTZ DEFAULT now()
updated_at TIMESTAMPTZ DEFAULT now()
```

### UI: Customers > Crisis

#### List Page (`/dashboard/crisis`)
- Table: Name, Status (badge), Affected Item, Customers Affected, Restock Date, Created
- "New Crisis" button
- Click → detail page

#### Create/Edit Page (`/dashboard/crisis/new` and `/dashboard/crisis/[id]`)
- **Name**: text input
- **Status**: draft / active / paused / resolved (toggle)
- **Affected Variant**: product + variant picker (from products table)
- **Default Flavor Swap**: variant picker (same product, different variant)
- **Available Flavor Swaps**: multi-select variant picker (Tier 1 options)
- **Available Product Swaps**: multi-select product+variant picker (Tier 2 options)
- **Tier 2 Coupon Code**: text input (Shopify coupon code)
- **Tier 2 Coupon %**: number input (default 20)
- **Expected Restock Date**: date picker
- **Lead Time Days**: number input (default 7)
- **Tier Wait Days**: number input (default 3, days between tier escalations)

#### Detail/Stats Page (`/dashboard/crisis/[id]`)
- **Stats cards**: Total affected, Tier 1 sent/accepted/rejected, Tier 2 sent/accepted/rejected, Tier 3 sent/accepted/rejected, Paused, Removed, Cancelled
- **Customer list**: sortable table with name, email, segment, current tier, response, action taken
- **Edit settings** button
- **Resolve Crisis** button (triggers mass re-add/unpause)

### API Endpoints
- `GET /api/workspaces/[id]/crisis` — list
- `POST /api/workspaces/[id]/crisis` — create
- `GET /api/workspaces/[id]/crisis/[crisisId]` — detail + stats
- `PATCH /api/workspaces/[id]/crisis/[crisisId]` — update settings + status
- `POST /api/workspaces/[id]/crisis/[crisisId]/resolve` — resolve crisis (mass actions)

### Sidebar
- "Crisis" under Customers group (owner/admin only)

### Deliverables
- Migration for both tables
- CRUD API endpoints
- List page + create/edit page + detail page with stats
- Sidebar link

---

## Session 2: Campaign Engine (Cron + Journeys + Actions)

### Inngest Cron: `crisis/daily-campaign`
- Runs daily at 8 AM Central
- For each **active** crisis event:

#### Step 1: Find eligible subscriptions
```
All active subs (including dunning) with the affected variant
WHERE subscription NOT already in crisis_customer_actions
AND next_billing_date <= now() + lead_time_days
```

#### Step 2: Create crisis_customer_actions records
- Determine segment: berry_only (only real item) vs berry_plus (has other items)
- Auto-swap the item to default_swap_variant_id (via Appstle/Shopify)
- Set current_tier = 1
- Create a ticket for the customer (channel: email)
- Send Tier 1 email with journey

#### Step 3: Advance tiers for existing records
```
For records WHERE current_tier = 1 AND tier1_response = 'rejected'
AND tier1_sent_at + tier_wait_days <= now()
→ Send Tier 2, set current_tier = 2

For records WHERE current_tier = 2 AND tier2_response = 'rejected'
AND tier2_sent_at + tier_wait_days <= now()
→ Send Tier 3, set current_tier = 3

For records WHERE current_tier = 3 AND tier3_response = 'rejected'
→ Berry-only: launch cancel journey
→ Berry+others: remove item permanently (auto_readd = false)
```

### Journey: Crisis Tier 1 — Flavor Swap
- **Step 1**: Single choice from available_flavor_swaps
  - Options: each flavor + "I don't want to change flavors"
- **On flavor pick**: swap the item on the subscription via Appstle
  - Record in crisis_customer_actions: tier1_response = 'accepted_swap', tier1_swapped_to = {variant}
- **On rejection**: tier1_response = 'rejected', wait for Tier 2

### Journey: Crisis Tier 2 — Product Swap + Coupon
- **Step 1**: Single choice from available_product_swaps
  - Shows product name + variant — customer picks one
  - Plus: "I don't want to change products"
- **Step 2** (if product picked): Quantity picker (1-4)
- **On product pick**: swap item on subscription + apply tier2_coupon_code via Appstle
  - Record: tier2_response = 'accepted_swap', tier2_swapped_to = {product, variant, qty}, tier2_coupon_applied = true
- **On rejection**: tier2_response = 'rejected', wait for Tier 3

### Journey: Crisis Tier 3 — Pause/Remove
- **Berry-only subs**: 
  - "We'll pause your subscription and automatically restart it when Mixed Berry is back in stock."
  - Options: "Pause until it's back" / "I'd rather cancel"
  - Pause: appstleSubscriptionAction(pause) → paused_at, auto_resume = true
  - Cancel: launch cancel journey
- **Berry+others subs**:
  - "We'll remove Mixed Berry from your subscription and keep shipping your other items. We'll add it back when it's in stock."
  - Options: "Remove it for now" / "I'd rather cancel the whole subscription"
  - Remove: Shopify subscription draft workflow (remove line item) → removed_item_at, auto_readd = true
  - Cancel: launch cancel journey

### Auto-Swap on Tier 1 Send (before customer responds)
When Tier 1 is sent, the system immediately swaps the item to default_swap_variant_id so the next order ships with the swap — customer can change it via the journey if they prefer a different flavor.

### Dunning Integration
- When finding eligible subs, include subs in `dunning_cycles` with status 'active'
- Same flow applies — dunning doesn't exempt from crisis outreach

### Deliverables
- Inngest cron function
- 3 journey builders (tier1_flavor_swap, tier2_product_swap, tier3_pause_remove)
- Journey completion handlers for all 3 tiers
- Appstle item swap helper (replace variant on subscription)
- Email templates for each tier
- Tier advancement logic

---

## Session 3: Resolution + Polish

### Crisis Resolution Flow
When admin clicks "Resolve Crisis":

1. **Auto-resume paused subs** (where auto_resume = true):
   - appstleSubscriptionAction(resume)
   - Update crisis_customer_actions
   - Email customer: "Great news! Mixed Berry is back in stock. Your subscription has been restarted."

2. **Auto-readd removed items** (where auto_readd = true):
   - Shopify subscription draft workflow (add line item back)
   - Update crisis_customer_actions
   - Email customer: "Mixed Berry is back! We've added it back to your subscription."

3. **Revert swapped items** (optional — configurable):
   - For customers who swapped to Strawberry Lemonade, offer to swap back
   - Journey: "Mixed Berry is back! Want us to switch you back?"
   - Don't auto-switch — let them choose

4. **Update crisis status** to 'resolved'

### Dashboard Enhancements
- Crisis banner on dashboard home when active crisis exists
- Crisis badge count on sidebar
- Affected customer indicator on customer detail + subscription detail pages

### Email Templates
- Tier 1: warm, empathetic, "we're sorry", auto-swap info + CTA to change flavor
- Tier 2: "we understand", product swap offer + 20% off highlight
- Tier 3: "we don't want you to go without", pause/remove with auto-restart promise
- Resolution: celebratory "it's back!" email

### Notifications
- Dashboard notification when crisis campaign sends a batch
- Summary notification: "Crisis Day 1: 45 Tier 1 emails sent, 12 already accepted flavor swap"
- Alert when rejection rate exceeds threshold (configurable)

---

## Testing Plan
1. Add Mixed Berry to Dylan's subscription
2. Create crisis in draft mode
3. Set lead_time_days to 0 (immediate) for testing
4. Activate crisis
5. Verify: auto-swap happens, email sent, journey works
6. Test Tier 1 rejection → Tier 2 sends after tier_wait_days
7. Test Tier 2 rejection → Tier 3
8. Test Tier 3 pause/remove
9. Test resolve → auto-resume/re-add
10. Reset lead_time_days to 7, set to active for production
