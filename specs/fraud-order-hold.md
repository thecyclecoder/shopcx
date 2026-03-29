# Fraud Order Hold + New Rules — Feature Spec

## Overview

Extend the real-time fraud detection system to immediately tag suspicious orders in Shopify, preventing fulfillment until manual review. Add two new fraud rules: billing/shipping address distance mismatch and billing name mismatch.

---

## Order Hold Flow

### Detection (real-time, on order webhook)
When `fraud/order.check` or `fraud/customer.check` Inngest events fire (triggered by Shopify `orders/create` webhook):

1. Fraud rules evaluate the order
2. If flagged → **immediately tag the Shopify order as "suspicious"** via Shopify GraphQL `tagsAdd` mutation
3. Create the fraud case as normal (AI summary, notification, etc.)
4. Store the Shopify order ID on the fraud case for reference

### Fulfillment center behavior
- Orders with "suspicious" tag are held — fulfillment center knows not to ship
- No code change needed on their end — they already filter by tags

### Agent review
- Fraud detail page shows the held order with "suspicious" badge
- Agent reviews the case
- **Dismiss** → remove "suspicious" tag from Shopify order via `tagsRemove` mutation → order released to fulfillment
- **Confirm fraud** → order stays tagged, agent can manually cancel it

---

## New Fraud Rules

### Rule: Billing/Shipping Address Distance (> 100 miles)
- **Type**: `address_distance`
- **Trigger**: Real-time on new order
- **Logic**:
  1. Get billing address from order's payment (or customer default)
  2. Get shipping address from order
  3. Geocode both addresses to lat/lng
  4. Calculate distance using Haversine formula
  5. If distance > threshold (default: 100 miles) → flag
- **Config**: `{ distance_threshold_miles: 100 }`
- **Severity**: medium (adjustable)
- **Geocoding**: Use a free geocoding API or simple zip-code-to-lat/lng lookup table. For US addresses, zip code centroids are sufficient (no need for full geocoding). Can use a static JSON file of US zip codes → lat/lng.

### Rule: Billing Name ≠ Customer Name
- **Type**: `name_mismatch`
- **Trigger**: Real-time on new order
- **Logic**:
  1. Get billing name from order payment
  2. Get customer name from customer record
  3. Compare (case-insensitive, handle common variations like "Bob" vs "Robert")
  4. If names don't match → flag
- **Config**: `{ ignore_last_name_match: true }` — if last names match, don't flag (could be spouse/family)
- **Severity**: low (adjustable)
- **Evidence**: Include both names in the fraud case evidence

---

## Shopify GraphQL for Order Tags

### Add tag
```graphql
mutation tagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node { id }
    userErrors { field message }
  }
}
```
Variables: `{ id: "gid://shopify/Order/{orderId}", tags: ["suspicious"] }`

### Remove tag
```graphql
mutation tagsRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) {
    node { id }
    userErrors { field message }
  }
}
```

Required scope: `write_orders`

---

## Fraud Detail Page Changes

### Order hold section
When a fraud case has associated orders with "suspicious" tag:
- Show an "Orders Held" section with amber/yellow styling
- Each held order shows: order number, items, total, shipping address
- Badge: "Held for Review" in amber
- When agent dismisses the case → auto-remove "suspicious" tag from all associated orders
- When agent confirms fraud → orders stay tagged

### Dismiss flow update
Current dismiss flow in `PATCH /api/workspaces/[id]/fraud-cases/[caseId]`:
- When status changes to "dismissed" → look up `order_ids` on the fraud case
- For each order ID → call Shopify `tagsRemove` to remove "suspicious"
- Log: "[System] Order {number} released from fraud hold"

---

## Database Changes

### fraud_rules — seed new rules
```sql
INSERT INTO fraud_rules (workspace_id, name, rule_type, config, severity, is_active)
VALUES
  ({ws_id}, 'Billing/Shipping Distance', 'address_distance', '{"distance_threshold_miles": 100}', 'medium', true),
  ({ws_id}, 'Billing Name Mismatch', 'name_mismatch', '{"ignore_last_name_match": true}', 'low', true);
```

### fraud_cases — add order hold tracking
```sql
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS orders_held BOOLEAN DEFAULT false;
```

---

## Zip Code Geocoding

For US zip-to-distance calculation, use a static dataset:
- Source: US Census Bureau zip code tabulation areas (free)
- ~42,000 zip codes with lat/lng centroids
- Store as a JSON file in the repo: `src/data/us-zipcodes.json`
- Format: `{ "90210": { lat: 34.0901, lng: -118.4065 }, ... }`
- Haversine formula for distance: `d = 2r × arcsin(sqrt(sin²((φ2-φ1)/2) + cos(φ1)cos(φ2)sin²((λ2-λ1)/2)))`

This avoids external API calls and works offline. ~2MB file, loaded once and cached in memory.

---

## Files to Create

| File | Purpose |
|------|---------|
| `supabase/migrations/YYYYMMDD_fraud_order_hold.sql` | orders_held column + new rule seeds |
| `src/lib/shopify-order-tags.ts` | Add/remove Shopify order tags via GraphQL |
| `src/data/us-zipcodes.json` | Static zip → lat/lng lookup (or use a lightweight npm package) |
| `src/lib/geo-distance.ts` | Haversine distance calculation from zip codes |

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/fraud-detector.ts` | Add address_distance + name_mismatch rules, call tagsAdd on flag |
| `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts` | On dismiss → remove "suspicious" tag from orders |
| `src/app/dashboard/fraud/[id]/page.tsx` | Show "Orders Held" section with held order details |
| `src/app/dashboard/settings/fraud/page.tsx` | Add config fields for new rules |
| `CLAUDE.md` | Update fraud section |

---

## Settings UI for New Rules

### Address Distance
- Enable/disable toggle
- Distance threshold (miles): number input, default 100
- Severity: dropdown (low/medium/high)

### Name Mismatch
- Enable/disable toggle
- "Ignore if last names match" toggle (default: on)
- Severity: dropdown (low/medium/high)
