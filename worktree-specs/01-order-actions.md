# Worktree: Shopify Order Actions

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-order-actions feature/order-actions
cd ../shopcx-order-actions
npm install
```

Work in `/Users/admin/Projects/shopcx-order-actions` — NOT main.

## What to Build

Agents need to take actions on Shopify orders directly from the ticket sidebar. Currently they can view order data but can't act on it.

## Shopify GraphQL Mutations Needed

### 1. Refund Order
```graphql
mutation refundCreate($input: RefundInput!) {
  refundCreate(input: $input) {
    refund { id }
    userErrors { field message }
  }
}
```
- Full refund or partial (by line item)
- Requires `write_orders` scope (verify it exists, add if not)

### 2. Cancel Order
```graphql
mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
  orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
    orderCancelUserErrors { field message }
  }
}
```
- Reasons: CUSTOMER, FRAUD, INVENTORY, DECLINED, OTHER
- Option to refund + restock

### 3. Update Shipping Address
```graphql
mutation orderUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id }
    userErrors { field message }
  }
}
```
- Update shippingAddress on unfulfilled orders only
- Validate address fields before sending

## Files to Create

### `src/lib/shopify-order-actions.ts`
```typescript
export async function refundOrder(workspaceId: string, shopifyOrderId: string, options: {
  full?: boolean;
  lineItems?: { lineItemId: string; quantity: number }[];
  reason?: string;
  notify?: boolean;
}): Promise<{ success: boolean; error?: string }>

export async function cancelOrder(workspaceId: string, shopifyOrderId: string, options: {
  reason: 'CUSTOMER' | 'FRAUD' | 'INVENTORY' | 'DECLINED' | 'OTHER';
  refund?: boolean;
  restock?: boolean;
  notify?: boolean;
}): Promise<{ success: boolean; error?: string }>

export async function updateShippingAddress(workspaceId: string, shopifyOrderId: string, address: {
  address1: string;
  address2?: string;
  city: string;
  province: string;
  zip: string;
  country: string;
}): Promise<{ success: boolean; error?: string }>
```

Use `getShopifyCredentials()` from `src/lib/shopify-sync.ts` for auth.
Use `SHOPIFY_API_VERSION` from `src/lib/shopify.ts`.

### `src/app/api/tickets/[id]/order-actions/route.ts`
- POST endpoint
- Body: `{ action: 'refund' | 'cancel' | 'update_address', order_id: string, ...options }`
- Auth: must be workspace member with admin/owner role
- Logs the action as an internal note on the ticket
- Returns success/error

### Ticket Detail UI Changes (`src/app/dashboard/tickets/[id]/page.tsx`)

In the customer sidebar where orders are displayed, add action buttons per order:

**For each order in the sidebar:**
- **Refund** button (only if financial_status is 'paid' or 'partially_refunded')
  - Opens inline form: full refund checkbox, or line item selector for partial
  - Confirm dialog: "Refund $X.XX to customer?"
- **Cancel** button (only if fulfillment_status is null/unfulfilled)
  - Reason dropdown (Customer, Inventory, Other)
  - Checkboxes: Refund payment, Restock items
  - Confirm dialog
- **Edit Address** button (only if fulfillment_status is null/unfulfilled)
  - Inline address form with current address pre-filled
  - Save button

All actions should:
1. Show loading state
2. On success: refresh order data, add internal note "Order #1234 refunded by [agent]"
3. On error: show error message inline

## Database Changes
None needed — actions go directly to Shopify and are logged as ticket messages.

## Architecture Notes
- Use `createAdminClient()` for all DB writes
- Shopify mutations use the workspace's encrypted access token
- All actions create an internal note on the ticket for audit trail
- The Shopify order ID is stored as `shopify_order_id` on the orders table (it's the numeric ID, prefix with `gid://shopify/Order/` for GraphQL)
- Check existing `src/lib/shopify-sync.ts` for the credential pattern

## Testing
1. Find a test order in the system
2. Try update address on an unfulfilled order
3. Try cancel on an unfulfilled order
4. Try refund on a paid order

## When Done
Push to `feature/order-actions` branch. Tell the merge manager (main terminal) to merge.
