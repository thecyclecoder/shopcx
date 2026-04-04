# Shopify Returns API Integration — Build Spec

## Overview

Integrate Shopify's Returns GraphQL API so ShopCX can create returns, track reverse deliveries, dispose returned items, and issue refunds/credits. This is the foundation layer — the returns dashboard and EasyPost label integration build on top of this.

## Shopify API Version

`2025-01` (our current version). Returns API available since `2023-01`, `reverseFulfillmentOrderDispose` replaces deprecated `reverseDeliveryDispose` as of `2025-01`.

## Required Scopes

Add to Shopify OAuth scopes: `read_returns`, `write_returns` (in addition to existing `read_orders`, `write_orders`).

## Database

### `returns` table (new)

```sql
CREATE TABLE IF NOT EXISTS public.returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  order_id UUID REFERENCES public.orders(id),
  order_number TEXT NOT NULL,
  shopify_order_gid TEXT NOT NULL,           -- gid://shopify/Order/123
  customer_id UUID REFERENCES public.customers(id),
  ticket_id UUID REFERENCES public.tickets(id),

  -- Shopify return IDs
  shopify_return_gid TEXT,                   -- gid://shopify/Return/123
  shopify_reverse_fulfillment_order_gid TEXT, -- auto-created by returnCreate
  shopify_reverse_delivery_gid TEXT,          -- created by reverseDeliveryCreateWithShipping

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',        -- Return created in our system, not yet in Shopify
    'open',           -- returnCreate called, Shopify return is OPEN
    'label_created',  -- EasyPost label generated (future)
    'in_transit',     -- Carrier tracking shows in transit
    'delivered',      -- Carrier tracking shows delivered to warehouse
    'processing',     -- Item received, being inspected
    'restocked',      -- reverseFulfillmentOrderDispose(RESTOCKED) called
    'refunded',       -- Refund/credit issued
    'closed',         -- returnClose called
    'cancelled'       -- Return cancelled
  )),

  -- Resolution
  resolution_type TEXT NOT NULL CHECK (resolution_type IN (
    'store_credit_return', 'refund_return', 'store_credit_no_return', 'refund_no_return'
  )),
  source TEXT NOT NULL DEFAULT 'playbook' CHECK (source IN ('playbook', 'agent', 'portal', 'shopify')),

  -- Financials
  order_total_cents INTEGER NOT NULL DEFAULT 0,
  label_cost_cents INTEGER NOT NULL DEFAULT 0,
  net_refund_cents INTEGER NOT NULL DEFAULT 0,
  refund_id TEXT,                             -- Shopify refund ID if refunded

  -- Tracking (populated by EasyPost or manually)
  tracking_number TEXT,
  carrier TEXT,
  label_url TEXT,
  easypost_shipment_id TEXT,

  -- Line items being returned
  return_line_items JSONB NOT NULL DEFAULT '[]',
  -- Format: [{ "shopify_fulfillment_line_item_id": "gid://...", "quantity": 1, "title": "Amazing Coffee" }]

  -- Timestamps
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read returns" ON public.returns FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on returns" ON public.returns FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_returns_workspace ON public.returns (workspace_id, status, created_at DESC);
CREATE INDEX idx_returns_order ON public.returns (order_number);
CREATE INDEX idx_returns_tracking ON public.returns (tracking_number) WHERE tracking_number IS NOT NULL;
```

### Workspace settings (additions)

```sql
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS return_address JSONB;
-- { "name": "Superfoods Company Returns", "street1": "...", "city": "...", "state": "...", "zip": "...", "country": "US", "phone": "..." }

ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS easypost_api_key_encrypted TEXT;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS default_return_parcel JSONB DEFAULT '{"length": 12, "width": 10, "height": 6, "weight": 16}';
-- length/width/height in inches, weight in ounces
```

## Core Library: `src/lib/shopify-returns.ts`

### Functions to implement

#### 1. `createShopifyReturn(workspaceId, params)`

Creates a return in Shopify and stores the record in our DB.

```typescript
interface CreateReturnParams {
  orderId: string;          // Our internal order UUID
  orderNumber: string;      // SC126222
  shopifyOrderGid: string;  // gid://shopify/Order/123
  customerId: string;
  ticketId?: string;
  resolutionType: string;
  returnLineItems: { fulfillmentLineItemId: string; quantity: number; title: string }[];
  source: "playbook" | "agent" | "portal";
}

// Returns: { returnId: string; shopifyReturnGid: string; reverseFulfillmentOrderGid: string }
```

**GraphQL mutation:**
```graphql
mutation ReturnCreate($input: ReturnInput!) {
  returnCreate(returnInput: $input) {
    return {
      id
      status
      reverseFulfillmentOrders(first: 1) {
        nodes {
          id
          status
          lineItems(first: 50) {
            nodes {
              id
              totalQuantity
              fulfillmentLineItem {
                id
                lineItem {
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

**Input shape:**
```json
{
  "returnInput": {
    "orderId": "gid://shopify/Order/123456",
    "returnLineItems": [
      {
        "fulfillmentLineItemId": "gid://shopify/FulfillmentLineItem/789",
        "quantity": 1,
        "returnReason": "UNWANTED",
        "customerNote": "Customer disputed charge via playbook"
      }
    ],
    "notifyCustomer": false
  }
}
```

**Important:** Set `notifyCustomer: false` — we send our own emails with the return label.

**After creation:**
- Store `return.id` as `shopify_return_gid`
- Store `return.reverseFulfillmentOrders.nodes[0].id` as `shopify_reverse_fulfillment_order_gid`
- Insert row into `returns` table with status `open`

#### 2. `attachReturnTracking(workspaceId, returnId, tracking)`

Attaches tracking info to the reverse delivery in Shopify.

```typescript
interface AttachTrackingParams {
  returnId: string;           // Our internal return UUID
  trackingNumber: string;
  trackingUrl?: string;
  carrier: string;            // "USPS", "UPS", "FedEx"
  labelUrl?: string;          // PDF URL from EasyPost
}
```

**GraphQL mutation:**
```graphql
mutation ReverseDeliveryCreate($reverseFulfillmentOrderId: ID!, $trackingInput: ReverseDeliveryTrackingInput, $labelInput: ReverseDeliveryLabelInput) {
  reverseDeliveryCreateWithShipping(
    reverseFulfillmentOrderId: $reverseFulfillmentOrderId
    trackingInput: $trackingInput
    labelInput: $labelInput
    notifyCustomer: false
  ) {
    reverseDelivery {
      id
      status
      deliverable {
        ... on ReverseDeliveryShippingDeliverable {
          tracking {
            number
            carrierName
          }
          label {
            publicFileUrl
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
```

**Variables:**
```json
{
  "reverseFulfillmentOrderId": "gid://shopify/ReverseFulfillmentOrder/456",
  "trackingInput": {
    "number": "9400111899223456789012",
    "url": "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789012"
  },
  "labelInput": {
    "fileUrl": "https://easypost-files.s3.amazonaws.com/label.pdf"
  }
}
```

**After creation:**
- Store `reverseDelivery.id` as `shopify_reverse_delivery_gid`
- Update return status to `label_created` (or `in_transit` if already picked up)

#### 3. `disposeReturnItems(workspaceId, returnId, disposition)`

Marks returned items as received/restocked in Shopify.

```typescript
type Disposition = "RESTOCKED" | "MISSING" | "PROCESSING_REQUIRED";

interface DisposeParams {
  returnId: string;
  disposition: Disposition;
  locationId?: string;  // Required for RESTOCKED — Shopify location GID
}
```

**GraphQL mutation:**
```graphql
mutation DisposeItems($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
  reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
    reverseFulfillmentOrderLineItems {
      id
      dispositionType
    }
    userErrors {
      field
      message
    }
  }
}
```

**Variables:**
```json
{
  "dispositionInputs": [
    {
      "reverseFulfillmentOrderLineItemId": "gid://shopify/ReverseFulfillmentOrderLineItem/789",
      "quantity": 1,
      "dispositionType": "RESTOCKED",
      "locationId": "gid://shopify/Location/123"
    }
  ]
}
```

**Note:** Can only dispose each unit once. Build disposition inputs from the reverse fulfillment order line items stored during `createShopifyReturn`.

**After dispose:**
- Update return status to `restocked`
- Set `processed_at`

#### 4. `closeReturn(workspaceId, returnId)`

Closes the return after refund/credit is issued.

```graphql
mutation ReturnClose($id: ID!) {
  returnClose(id: $id) {
    return {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}
```

**After close:**
- Update return status to `closed`

#### 5. `getReturnableItems(workspaceId, shopifyOrderGid)`

Query order fulfillments to find which line items can be returned.

```graphql
query OrderReturnable($id: ID!) {
  order(id: $id) {
    id
    name
    fulfillments {
      id
      status
      fulfillmentLineItems(first: 50) {
        nodes {
          id
          originalTotalSet {
            shopMoney { amount currencyCode }
          }
          quantity
          lineItem {
            title
            variant {
              id
              weight
              weightUnit
            }
          }
        }
      }
    }
    returns(first: 10) {
      nodes {
        id
        status
        returnLineItems(first: 50) {
          nodes {
            fulfillmentLineItem { id }
            quantity
          }
        }
      }
    }
  }
}
```

This tells us: which items were fulfilled, which have already been returned, and what's left to return.

## Shopify Webhooks

Register these webhooks during Shopify OAuth setup:

### `returns/create`
Fires when a return is created (by us or by Shopify admin). Useful for syncing returns created manually in Shopify.

### `returns/update`  
Fires when return status changes. Update our `returns.status` accordingly.

### `reverse_fulfillment_orders/dispose`
Fires when items are disposed (restocked/missing). Useful if warehouse staff disposes via Shopify admin rather than our API.

### Webhook handler: `src/app/api/webhooks/shopify-returns/route.ts`

```typescript
// POST handler
// 1. Verify HMAC
// 2. Parse topic from X-Shopify-Topic header
// 3. Switch on topic:
//    - returns/create: upsert to returns table if not already tracked
//    - returns/update: update status
//    - reverse_fulfillment_orders/dispose: update status to restocked, trigger refund flow
```

## Inngest Functions

### `returns/process-delivery` 
Triggered when tracking shows delivered. Waits 24 hours (for warehouse to inspect), then auto-disposes as RESTOCKED and triggers refund/credit.

### `returns/issue-refund`
Triggered after disposal. Issues store credit (via existing store credit system) or Shopify refund. Sends confirmation email. Closes return.

## Integration with Playbook Executor

Update `handleInitiateReturn` in `src/lib/playbook-executor.ts`:

Currently it logs intent. Replace with actual calls:

```typescript
// 1. Get returnable items from Shopify
const items = await getReturnableItems(wsId, shopifyOrderGid);

// 2. Create the return
const result = await createShopifyReturn(wsId, {
  orderId, orderNumber, shopifyOrderGid, customerId,
  ticketId: tid,
  resolutionType: ctx.resolution_type as string,
  returnLineItems: items,
  source: "playbook",
});

// 3. (Future: EasyPost label generation + attach tracking)
// For now, return is created in Shopify, tracking added manually or via EasyPost later
```

## API Routes

### `GET /api/workspaces/[id]/returns`
List returns with filters (status, resolution, source, date range). Paginated.

### `GET /api/workspaces/[id]/returns/[returnId]`
Return detail with full timeline.

### `POST /api/workspaces/[id]/returns`
Create a return (agent-initiated from ticket or order detail).

### `PATCH /api/workspaces/[id]/returns/[returnId]`
Update return (add tracking, change status, add notes).

### `POST /api/workspaces/[id]/returns/[returnId]/dispose`
Mark items as received/restocked.

### `POST /api/workspaces/[id]/returns/[returnId]/refund`
Issue the refund or store credit.

## Order of Implementation

1. Migration: `returns` table + workspace columns
2. `src/lib/shopify-returns.ts` — core functions (createShopifyReturn, attachReturnTracking, disposeReturnItems, closeReturn, getReturnableItems)
3. Webhook handler: `src/app/api/webhooks/shopify-returns/route.ts`
4. API routes: CRUD for returns
5. Update playbook executor `handleInitiateReturn` to call real Shopify API
6. Inngest functions: process-delivery, issue-refund
7. Sidebar nav: add "Returns" item

## Key Files (will create)

- `src/lib/shopify-returns.ts` — Shopify GraphQL return mutations + queries
- `src/app/api/webhooks/shopify-returns/route.ts` — Webhook handler
- `src/app/api/workspaces/[id]/returns/route.ts` — List + create
- `src/app/api/workspaces/[id]/returns/[returnId]/route.ts` — Detail + update
- `src/app/api/workspaces/[id]/returns/[returnId]/dispose/route.ts` — Dispose items
- `src/app/api/workspaces/[id]/returns/[returnId]/refund/route.ts` — Issue refund/credit
- `src/lib/inngest/returns.ts` — Inngest functions for async processing
- `supabase/migrations/XXXXXXXX_returns.sql` — Schema
