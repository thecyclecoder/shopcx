# Loyalty System — ShopCX Phase 8 (Native Engine)

## Overview

Native loyalty engine built into ShopCX. No third-party provider. Customers earn points on purchases, redeem points for discount coupons ($5, $10, $15) via the customer portal or Shopify checkout. Points are imported from Smile.io via JSON export, then all earning/spending is handled natively.

---

## 1. Core Model

- **Earning**: Customers earn points on qualifying purchases (configurable rate, e.g., 10 points per $1 spent)
- **Conversion**: Configurable (e.g., 100 points = $1)
- **Redemption tiers**: Configurable in settings (default: $5, $10, $15 — admin can change amounts and point costs)
- **Limit**: 1 loyalty coupon per order
- **Coupon scope**: Setting for one-time purchase, subscription, or both
- **Coupon stacking**: Setting for `combinesWith` — product discounts, shipping discounts, order discounts (default: product + shipping allowed, order discounts NOT allowed)
- **Order total deductions**: Setting for what to exclude from points-qualifying amount — tax, discounts, shipping, shipping protection (only true line item spend qualifies)

---

## 2. Database

### Migration: `supabase/migrations/XXXXXX_loyalty_tables.sql`

```sql
-- Loyalty members
CREATE TABLE loyalty_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  customer_id uuid REFERENCES customers(id),
  shopify_customer_id text,
  email text,
  points_balance integer NOT NULL DEFAULT 0,
  points_earned integer NOT NULL DEFAULT 0,
  points_spent integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'native',  -- 'native' or 'import'
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(workspace_id, shopify_customer_id)
);

-- Points transactions (append-only ledger)
CREATE TABLE loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  member_id uuid NOT NULL REFERENCES loyalty_members(id),
  points_change integer NOT NULL,   -- positive = earned, negative = spent
  type text NOT NULL,               -- 'earning', 'spending', 'adjustment', 'import', 'refund', 'chargeback'
  description text,
  order_id text,                    -- Shopify order ID if from purchase/refund
  shopify_discount_id text,         -- Shopify discount GID if from redemption
  created_at timestamptz DEFAULT now()
);

-- Reward redemptions
CREATE TABLE loyalty_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  member_id uuid NOT NULL REFERENCES loyalty_members(id),
  reward_tier text NOT NULL,        -- e.g., "$5", "$10", "$15"
  points_spent integer NOT NULL,
  discount_code text NOT NULL,      -- the generated Shopify code
  shopify_discount_id text,         -- Shopify discount node GID
  discount_value numeric NOT NULL,  -- 5, 10, or 15
  status text NOT NULL DEFAULT 'active', -- 'active', 'used', 'expired'
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Loyalty settings per workspace
CREATE TABLE loyalty_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  enabled boolean NOT NULL DEFAULT false,
  -- Earning
  points_per_dollar integer NOT NULL DEFAULT 10,
  -- Conversion display
  points_per_dollar_value integer NOT NULL DEFAULT 100,  -- 100 points = $1
  -- Redemption tiers (JSONB array for flexibility)
  redemption_tiers jsonb NOT NULL DEFAULT '[
    {"label": "$5 Off", "points_cost": 500, "discount_value": 5},
    {"label": "$10 Off", "points_cost": 1000, "discount_value": 10},
    {"label": "$15 Off", "points_cost": 1500, "discount_value": 15}
  ]'::jsonb,
  -- Coupon settings
  coupon_applies_to text NOT NULL DEFAULT 'both',  -- 'one_time', 'subscription', 'both'
  coupon_combines_product boolean NOT NULL DEFAULT true,
  coupon_combines_shipping boolean NOT NULL DEFAULT true,
  coupon_combines_order boolean NOT NULL DEFAULT false,
  coupon_expiry_days integer NOT NULL DEFAULT 90,
  -- Order total deductions (what to EXCLUDE from points-qualifying amount)
  exclude_tax boolean NOT NULL DEFAULT true,
  exclude_discounts boolean NOT NULL DEFAULT true,
  exclude_shipping boolean NOT NULL DEFAULT true,
  exclude_shipping_protection boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

RLS: workspace_id scoped, same pattern as all other tables.

---

## 3. Import Script

### `scripts/import-loyalty.ts` (standalone, not production code)

- Reads `tmp/customers_2026-03-30T17_54_27.736397284Z.json`
- JSON format per record: `{ "Smile Customer ID", "First name", "Last name", "Email", "Membership status", "Points balance", "Referral url", "Vip tier name", "Date of birth" }`
- Points balance is comma-formatted string (e.g., "89,085") — parse to integer
- **Match by email** to `customers` table (workspace-scoped)
- **Skip** customers not found in our DB (log warning with email)
- **Skip** customers with 0 points (the export should already exclude them, but guard anyway)
- For each matched customer:
  - Upsert `loyalty_members` with `source: 'import'`, `points_balance`, `points_earned` = same as balance (historical total unknown, use balance as starting earned)
  - Insert `loyalty_transactions` with `type: 'import'`, `points_change` = balance, `description: 'Imported from Smile.io'`
- Log summary: imported count, skipped count, total points imported
- Run via: `npx tsx scripts/import-loyalty.ts`

---

## 4. Core Logic (`src/lib/loyalty.ts`)

Provider-agnostic loyalty business logic (keep what was already built, remove Smile references):

- `getLoyaltySettings(workspaceId)` — fetch settings with defaults
- `getMember(workspaceId, shopifyCustomerId)` — get or null
- `getOrCreateMember(workspaceId, shopifyCustomerId, email)` — upsert
- `getRedemptionTiers(settings)` — parse tiers from settings
- `validateRedemption(member, tier)` — check balance >= cost
- `pointsToDollarValue(points, settings)` — conversion for display
- `calculateEarningPoints(orderTotal, deductions, settings)` — apply exclusions, calculate points
- `earnPoints(member, points, orderId, description)` — insert transaction, update balance
- `spendPoints(member, points, description, discountId)` — insert transaction, update balance
- `deductPoints(member, points, orderId, type, description)` — for refunds/chargebacks

---

## 5. Points Earning (Shopify Webhooks)

### 5a. `orders/create` webhook (extend existing handler)

When an order is created and payment is confirmed:
1. Look up loyalty settings for the workspace — if not enabled, skip
2. Look up or create `loyalty_members` row for the customer
3. Calculate qualifying amount from order:
   - Start with line items total
   - Subtract based on settings: tax, discounts, shipping, shipping protection
   - `qualifying_amount = line_items_total - excluded_amounts`
4. Calculate points: `floor(qualifying_amount * points_per_dollar)`
5. Call `earnPoints()` — creates transaction + updates balance
6. Skip if order has tag `loyalty:skip`

### 5b. `refunds/create` webhook

When a refund is issued:
1. Calculate refund qualifying amount (same exclusion logic)
2. Deduct points: `floor(refund_qualifying_amount * points_per_dollar)`
3. Call `deductPoints()` with type `'refund'`
4. Don't let balance go below 0

### 5c. Chargeback integration

Extend existing chargeback processing pipeline:
1. When a chargeback is confirmed (status `lost`), deduct points for the full order amount
2. Call `deductPoints()` with type `'chargeback'`
3. Don't let balance go below 0

---

## 6. Redemption Flow

### 6a. API endpoint: `POST /api/loyalty/redeem`

Request: `{ shopifyCustomerId, tierId (index into tiers array) }`

1. Validate: loyalty enabled, member exists, sufficient balance
2. Get the tier from settings
3. Create Shopify discount code via `discountCodeBasicCreate`:

```graphql
mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}
```

Input:
```json
{
  "title": "Loyalty $10 - {customer_name}",
  "code": "LOYALTY-10-{RANDOM_6}",
  "customerSelection": {
    "customers": { "add": ["gid://shopify/Customer/{id}"] }
  },
  "appliesOncePerCustomer": true,
  "usageLimit": 1,
  "combinesWith": {
    "productDiscounts": settings.coupon_combines_product,
    "shippingDiscounts": settings.coupon_combines_shipping,
    "orderDiscounts": settings.coupon_combines_order
  },
  "customerGets": {
    "appliesToOneTimePurchase": settings.coupon_applies_to !== 'subscription',
    "appliesToSubscription": settings.coupon_applies_to !== 'one_time',
    "items": { "all": true },
    "value": { "discountAmount": { "amount": tier.discount_value, "appliesOnEachItem": false } }
  },
  "startsAt": "now",
  "endsAt": "+{coupon_expiry_days} days"
}
```

4. Deduct points via `spendPoints()`
5. Insert `loyalty_redemptions` row with code, discount ID, expiry
6. Return `{ ok: true, code, discount_value, expires_at }`

### 6b. Coupon naming convention
- Format: `LOYALTY-{VALUE}-{RANDOM_6CHAR}` (e.g., `LOYALTY-10-A3F9XK`)
- Title in Shopify: `Loyalty ${value} - {customer first name} {customer last initial}` for admin readability

### 6c. Coupon usage tracking
- On `orders/create` webhook: check if order used a `LOYALTY-*` discount code
- If yes: update `loyalty_redemptions.status = 'used'`, set `used_at`

---

## 7. Shopify Checkout Extension

### 7a. Extension setup

New extension in `shopify-extension/extensions/loyalty-checkout/`:
- Type: `ui_extension` / `Checkout::Dynamic::Render` (checkout UI extension)
- Uses Shopify checkout UI components (React-based)
- Renders in the checkout sidebar or below line items

Add to `shopify.app.toml`:
```toml
[[extensions]]
type = "checkout_ui_extension"
name = "Loyalty Rewards"
handle = "loyalty-checkout"

[extensions.settings]
[[extensions.settings.fields]]
key = "api_endpoint"
type = "single_line_text_field"
name = "API Endpoint"
```

### 7b. Extension behavior

1. On load: check if customer is authenticated (use `useAuthenticatedAccountCustomer()` from Shopify checkout API)
2. If authenticated: call our API to get points balance + available tiers
   - Endpoint: `GET /api/portal?route=loyaltyBalance` (or dedicated endpoint)
   - Auth: use the logged-in customer's Shopify ID
3. Display:
   - "You have **{points}** reward points (worth **${dollar_value}**)"
   - Available redemption buttons: only show tiers the customer can afford
   - Grayed out tiers they can't afford with "Need {X} more points"
4. On redeem click:
   - Call `POST /api/loyalty/redeem` with customer ID + tier
   - Receive discount code
   - Apply to checkout via `applyDiscountCodeChange` Shopify checkout API
   - Update displayed balance (subtract points spent)
   - Show success: "Applied {code} — ${value} off!"
5. If customer has no points or loyalty is disabled: hide the extension entirely

### 7c. API endpoint for checkout: `GET /api/loyalty/balance`

- Accepts `shopifyCustomerId` (from checkout context)
- Returns: `{ points_balance, tiers: [{ label, points_cost, discount_value, affordable: bool }], dollar_value }`
- Workspace resolved from shop domain (same as portal auth)

### 7d. Security considerations

- The checkout extension runs in Shopify's sandbox — it can only call allowed URLs
- Our redeem endpoint must validate the customer ID matches the authenticated checkout customer
- Rate limit redemptions (1 per checkout session)

---

## 8. Customer Portal Integration

### 8a. Portal home screen
- Show points balance: "You have **{points}** reward points"
- Show dollar equivalent: "That's worth **${value}** in rewards"

### 8b. Portal subscription detail
- Add a loyalty/rewards section (can combine with existing RewardsCard)
- Show balance + redeem buttons for affordable tiers
- On redeem: call redeem API, show the discount code, tell customer to apply at checkout
- Or: "This coupon has been added to your account and will auto-apply on your next order"

### 8c. Portal route handlers
- `loyaltyBalance` — GET, returns member balance + tiers
- `loyaltyRedeem` — POST, creates discount code, deducts points, returns code

---

## 9. Dashboard Pages

### 9a. Sidebar nav
- "Loyalty" menu item between Subscriptions and Customers

### 9b. `/dashboard/loyalty` — Overview
- **Stats row**: Total members, total points outstanding, redemptions this month, points earned this month
- **Members table**: Searchable by name/email, sortable by points_balance
  - Columns: Customer name, email, points balance, points earned, points spent, last activity
  - Click → customer detail page
- **Recent transactions**: Last 50 across all members

### 9c. Customer detail integration
- Add loyalty section to existing customer page / ticket sidebar
- Points balance, transaction history, redemption history
- Manual adjust button (admin only): award or deduct points with note

---

## 10. Settings > Loyalty (`/dashboard/settings/loyalty`)

Admin-only settings page:

### Earning Settings
- **Points per dollar spent**: integer input (default: 10)
- **Order deductions** (checkboxes for what to EXCLUDE from qualifying amount):
  - Tax
  - Discounts already applied
  - Shipping costs
  - Shipping protection

### Conversion Settings
- **Points per dollar value**: integer input (default: 100 — meaning 100 points = $1)

### Redemption Tiers
- Editable list of tiers, each with:
  - Label (e.g., "$5 Off")
  - Points cost (e.g., 500)
  - Discount value in dollars (e.g., 5)
- Add / remove tiers
- Min 1 tier, no max

### Coupon Settings
- **Applies to**: dropdown — One-time purchase / Subscription / Both
- **Combines with** (checkboxes):
  - Product discounts (default: on)
  - Shipping discounts (default: on)
  - Order discounts (default: off)
- **Coupon expiry**: days until expiry (default: 90)

### Enable/Disable
- Master toggle to enable/disable the loyalty system

---

## 11. AI Agent Context

Add to `ai-context.ts` assembler:
- Include points balance in customer profile section
- AI can reference: "You have X points — that's worth $Y toward your next order"
- AI should NOT auto-redeem — only inform

---

## 12. Cancel Journey Integration

Add loyalty as a retention lever in cancel journey:
- If customer has points > 0: "You have {X} points worth ${Y} — you'll lose these if you cancel"
- Display on the cancel confirmation step as a reminder, not a remedy

---

## File Summary

| File | Purpose |
|------|---------|
| `scripts/import-loyalty.ts` | One-time import from Smile.io JSON export |
| `src/lib/loyalty.ts` | Core loyalty logic (earning, spending, validation, calculations) |
| `src/lib/inngest/loyalty.ts` | Loyalty-related Inngest functions (if needed for async) |
| `src/app/api/loyalty/redeem/route.ts` | Redemption endpoint (creates Shopify discount) |
| `src/app/api/loyalty/balance/route.ts` | Balance check endpoint (for checkout extension) |
| `src/app/api/loyalty/members/route.ts` | Members list + detail API |
| `src/app/api/loyalty/adjust/route.ts` | Manual points adjustment (admin) |
| `src/app/dashboard/loyalty/page.tsx` | Loyalty overview dashboard |
| `src/app/dashboard/settings/loyalty/page.tsx` | Loyalty settings (earning, conversion, tiers, coupons) |
| `src/lib/portal/handlers/loyalty-balance.ts` | Portal: balance check |
| `src/lib/portal/handlers/loyalty-redeem.ts` | Portal: redemption |
| `shopify-extension/extensions/loyalty-checkout/` | Shopify checkout UI extension |
| `supabase/migrations/XXXXXX_loyalty_tables.sql` | DB migration |

## Implementation Order

1. DB migration (loyalty_members, loyalty_transactions, loyalty_redemptions, loyalty_settings)
2. `src/lib/loyalty.ts` — core logic
3. Settings > Loyalty page (earning, conversion, tiers, coupon settings)
4. Import script (run once to seed from Smile.io export)
5. Points earning on `orders/create` webhook + deduction on refunds/chargebacks
6. Redemption API + Shopify discount code creation
7. Dashboard loyalty page (members, stats, transactions)
8. Customer sidebar loyalty section
9. Portal integration (balance + redeem)
10. Shopify checkout extension
11. AI context + cancel journey integration
12. Sidebar nav + settings card
