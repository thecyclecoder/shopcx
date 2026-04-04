# Return Label API — EasyPost Integration Spec

## Overview

When a playbook initiates a return, we generate a prepaid return shipping label via EasyPost, email it to the customer, and track the shipment automatically. The label cost is deducted from the refund or store credit amount.

## Why EasyPost

- Developer-first API, simple REST calls
- No monthly fee, pay per label at discounted carrier rates
- No interference with 3PL outbound fulfillment
- Supports USPS, UPS, FedEx, DHL (we'd primarily use USPS Ground Advantage)
- Returns pre-built label URL (PDF) and tracking number in one call

## Data Flow

```
PHASE 1: Rate Quote (during offer_exception step)
1. Fetch order line items → get product weights from Shopify
2. Call EasyPost: create shipment (from: customer address, to: warehouse, parcel: dimensions)
3. DON'T buy yet — just get rates[] back
4. Pick cheapest rate → calculate: order_total - label_cost = net_refund
5. AI presents offer with exact breakdown:
   "Your refund would be $67.61 ($74.81 order minus $7.20 return shipping)"
6. Store easypost_shipment_id in playbook_context for later purchase

PHASE 2: Purchase Label (during initiate_return step, after customer accepts)
7. Buy the previously quoted rate on the stored shipment ID
8. Get back: label PDF URL + tracking number
9. Store return record in DB
10. Email label PDF to customer
11. Create Shopify return via returnCreate
12. Attach tracking via reverseDeliveryCreateWithShipping

PHASE 3: Tracking (automated, post-playbook)
13. EasyPost webhook or polling: track shipment status
14. Item delivered to warehouse → reverseFulfillmentOrderDispose(RESTOCKED)
15. Issue refund/credit for net_refund amount
16. Notify customer: "We received your return, your [refund/credit] of $X has been issued"
```

## Key Design: Quote Before Accept

EasyPost lets you create a shipment and get rates WITHOUT buying. This means:
- At the **offer step**, we can tell the customer the exact net amount
- No surprises — "Your store credit will be $67.61 ($74.81 minus $7.20 shipping)"
- The shipment ID is stored in `playbook_context.easypost_shipment_id`
- At the **initiate_return step**, we buy the rate on the existing shipment
- Rate is guaranteed for 7 days after quote (EasyPost policy)

## API Endpoint

### `POST /api/workspaces/[id]/returns/create-label`

**Request:**
```json
{
  "order_id": "uuid",           // Our internal order ID
  "order_number": "SC126222",   // Shopify order number
  "customer_id": "uuid",        // Customer record
  "resolution_type": "refund_return" | "store_credit_return",
  "ticket_id": "uuid"           // Link back to the ticket
}
```

**Process:**
1. Look up the order → get line items with variant IDs
2. For each variant, fetch product dimensions from Shopify:
   - `weight` (grams) — stored on variant
   - `requires_shipping` — must be true
   - If dimensions not on variant, use product-level defaults or workspace default box size
3. Calculate total parcel: sum weights, use largest dimensions or workspace default box
4. Look up customer's shipping address from the order (Shopify `shippingAddress`)
5. Look up warehouse return address from workspace settings (new field: `return_address`)
6. Call EasyPost:
   - Create shipment with from/to/parcel
   - Buy lowest rate (filter by `service: "GroundAdvantage"` for USPS or cheapest overall)
7. Store return record in `returns` table
8. Email label to customer via Resend
9. Create Shopify return via `returnCreate` mutation
10. Attach tracking via `reverseDeliveryCreateWithShipping`

**Response:**
```json
{
  "ok": true,
  "return_id": "uuid",
  "tracking_number": "9400111899223456789012",
  "carrier": "USPS",
  "label_url": "https://easypost-files.s3.amazonaws.com/...",
  "label_cost_cents": 720,
  "net_refund_cents": 6761
}
```

## Database

### `returns` table (new)

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| workspace_id | UUID FK | |
| order_id | UUID FK | Internal order ID |
| order_number | TEXT | Shopify order number |
| customer_id | UUID FK | |
| ticket_id | UUID FK | Originating ticket |
| shopify_return_id | TEXT | From returnCreate response |
| status | TEXT | `label_created`, `shipped`, `in_transit`, `delivered`, `processed`, `refunded` |
| resolution_type | TEXT | `store_credit_return`, `refund_return` |
| tracking_number | TEXT | From EasyPost |
| carrier | TEXT | USPS, UPS, etc. |
| label_url | TEXT | PDF download URL |
| label_cost_cents | INTEGER | What we paid for the label |
| order_total_cents | INTEGER | Original order total |
| net_refund_cents | INTEGER | order_total - label_cost |
| easypost_shipment_id | TEXT | For tracking updates |
| shipped_at | TIMESTAMPTZ | When tracking shows picked up |
| delivered_at | TIMESTAMPTZ | When tracking shows delivered |
| processed_at | TIMESTAMPTZ | When we disposed in Shopify |
| refunded_at | TIMESTAMPTZ | When credit/refund issued |
| created_at | TIMESTAMPTZ | |

### Workspace settings (additions)

| Column | Type | Description |
|--------|------|-------------|
| return_address | JSONB | `{ name, street1, street2, city, state, zip, country, phone }` |
| easypost_api_key_encrypted | TEXT | AES-256-GCM encrypted |
| default_return_parcel | JSONB | Fallback dimensions: `{ length, width, height, weight }` (inches/oz) |

## EasyPost API Calls

### 1. Get Rate Quote (offer_exception step)

```typescript
// Create shipment WITHOUT buying — just to get rates
const shipment = await easypost.Shipment.create({
  from_address: {
    name: customer.first_name + " " + customer.last_name,
    street1: order.shipping_address.address1,
    street2: order.shipping_address.address2,
    city: order.shipping_address.city,
    state: order.shipping_address.province_code,
    zip: order.shipping_address.zip,
    country: order.shipping_address.country_code,
  },
  to_address: workspace.return_address,
  parcel: {
    length: parcel.length,    // inches
    width: parcel.width,      // inches
    height: parcel.height,    // inches
    weight: parcel.weight,    // ounces
  },
  is_return: true,
});

// Get cheapest rate (don't buy yet)
const rate = shipment.lowestRate(["USPS"], ["GroundAdvantage", "Priority"]);
const labelCostCents = Math.round(parseFloat(rate.rate) * 100);
const netRefundCents = orderTotalCents - labelCostCents;

// Store for later purchase
// → playbook_context.easypost_shipment_id = shipment.id
// → playbook_context.label_cost_cents = labelCostCents
// → playbook_context.net_refund_cents = netRefundCents

// AI says: "Your refund would be $67.61 ($74.81 minus $7.20 return shipping)"
```

### 2. Buy Label (initiate_return step, after acceptance)

```typescript
// Purchase the previously quoted rate
const purchased = await easypost.Shipment.buy(
  ctx.easypost_shipment_id,  // From playbook_context
  rate,
);

// Result:
// purchased.tracking_code — tracking number
// purchased.postage_label.label_url — PDF label
// purchased.selected_rate.rate — cost (matches quote)
```

### 2. Track Shipment (webhook or poll)

```typescript
// Register webhook for tracking updates
// EasyPost sends POST to our webhook URL with tracker events
// Events: pre_transit, in_transit, out_for_delivery, delivered, failure

// Or poll:
const tracker = await easypost.Tracker.retrieve(trackerId);
// tracker.status: "pre_transit" | "in_transit" | "delivered" | etc.
```

## Product Dimensions

Shopify stores dimensions on product variants:
- `weight` (in the shop's weight unit, usually grams or oz)
- `weight_unit` ("g", "kg", "oz", "lb")
- Dimensions are NOT standard on variants — they're on the inventory item:
  - `inventoryItem.measurement.weight`
  - Shopify doesn't store box dimensions (L/W/H) natively

**Strategy:**
1. Use product `weight` from our `products` table (synced from Shopify)
2. For box dimensions, use workspace `default_return_parcel` setting
3. Admin sets default box size in Settings > Integrations > Returns (e.g. 12x10x6 inches)
4. Weight = sum of line item weights. If missing, use workspace default weight.

## Email to Customer

Sent via Resend when label is generated:

**Subject:** "Your return label for order {order_number}"

**Body:**
- Brief: "We've generated a return shipping label for your order."
- Attached or linked: PDF label
- Instructions: "Print this label, attach it to your package, and drop it off at any {carrier} location."
- Tracking: "Your tracking number is {tracking_number}. We'll automatically track your return and process your {refund/credit} once we receive it."
- Amount: "Your {refund/credit} amount: ${net_refund} (${order_total} minus ${label_cost} shipping)"

## Returns Dashboard Page

`/dashboard/returns` — sidebar item below Subscriptions

| Column | Sortable | Description |
|--------|----------|-------------|
| Order # | Yes | Link to order |
| Customer | Yes | Name + email |
| Status | Yes | Badge: Label Created / Shipped / In Transit / Delivered / Processed / Refunded |
| Resolution | - | Store Credit / Refund |
| Amount | Yes | Net refund amount |
| Label Cost | - | What we paid for shipping |
| Tracking | - | Number + carrier, clickable to carrier site |
| Source | - | AI Playbook / Agent / Portal |
| Created | Yes | Date |

Filters: status, resolution type, source, date range

## Settings UI

Settings > Integrations > Returns card:
- EasyPost API key (encrypted)
- Return address (form fields)
- Default parcel dimensions (L/W/H in inches, weight in oz)
- Preferred carrier (USPS default)
- Test connection button

## Shopify Integration

After creating the EasyPost label:

1. **Create return in Shopify:**
```graphql
mutation returnCreate($input: ReturnInput!) {
  returnCreate(input: $input) {
    return { id }
    userErrors { field message }
  }
}
```

2. **Attach tracking to reverse delivery:**
```graphql
mutation reverseDeliveryCreateWithShipping($input: ReverseDeliveryCreateWithShippingInput!) {
  reverseDeliveryCreateWithShipping(input: $input) {
    reverseDelivery { id }
    userErrors { field message }
  }
}
```

3. **On delivery confirmed — dispose items:**
```graphql
mutation reverseFulfillmentOrderDispose($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
  reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
    reverseFulfillmentOrderLineItems { id }
    userErrors { field message }
  }
}
```

## Webhook: Tracking Updates

`POST /api/webhooks/easypost`

EasyPost sends tracking events. On status change:
- Update `returns.status`
- `in_transit` → set `shipped_at`
- `delivered` → set `delivered_at`, trigger dispose + refund flow
- `failure` → create dashboard notification, alert agent

## Dependencies

- `easypost` npm package (official Node.js client)
- Resend (already integrated) for emailing labels
- Shopify GraphQL (already integrated) for return creation + reverse delivery
- Workspace `return_address` + `easypost_api_key_encrypted` settings
- Product weights from `products` table (already synced from Shopify)
