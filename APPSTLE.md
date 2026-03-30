# Appstle API Reference

Base URL: `https://subscription-admin.appstle.com`
Auth: `X-API-Key` header (per-workspace, encrypted in DB)

## Subscription Management

### Cancel Subscription
```
DELETE /api/external/v2/subscription-contracts/{contractId}?cancellationFeedback={reason}&cancellationNote={note}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSubscriptionAction("cancel")`

### Pause / Resume Subscription
```
PUT /api/external/v2/subscription-contracts-update-status?contractId={id}&status={PAUSED|ACTIVE}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSubscriptionAction("pause"|"resume")`, portal pause/resume handlers

### Skip Next Order
```
PUT /api/external/v2/subscription-contracts-skip?contractId={id}&api_key={key}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSkipNextOrder()`

### Update Billing Interval (Frequency)
```
PUT /api/external/v2/subscription-contracts-update-billing-interval?contractId={id}&interval={DAY|WEEK|MONTH|YEAR}&intervalCount={n}&api_key={key}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleUpdateBillingInterval()`

### Update Next Billing Date
```
PUT /api/external/v2/subscription-contracts-update-billing-date?contractId={id}&rescheduleFutureOrder=true&nextBillingDate={ISO8601}
```
- **Response**: `204 No Content` (no body)
- **Used in**: portal reactivate handler, dunning scripts

### Update Shipping Address
```
PUT /api/external/v2/subscription-contracts-update-shipping-address?contractId={id}
Content-Type: application/json

{
  "address1": "...", "address2": "...", "city": "...", "zip": "...",
  "country": "United States", "countryCode": "US",
  "province": "CA", "provinceCode": "CA",
  "firstName": "...", "lastName": "...",
  "methodType": "SHIPPING",
  "phone": "...", "company": "..."
}
```
- **Response**: `200 OK` or `204 No Content` (response not checked)
- **Used in**: `src/lib/portal/handlers/address.ts`

### Swap Product (Simple 1:1)
```
PUT /api/external/v2/subscription-contracts-swap?contractId={id}&oldVariantId={id}&newVariantId={id}&api_key={key}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSwapProduct()`

## Item Mutations (Replace Variants v3)

### Replace / Add / Remove Items
```
POST /api/external/v2/subscription-contract-details/replace-variants-v3
Content-Type: application/json

{
  "shop": "store.myshopify.com",
  "contractId": 123456,
  "eventSource": "CUSTOMER_PORTAL",
  "oldVariants": [123, 456],           // variant IDs to remove
  "oldLineId": "gid://...",            // OR single line ID to remove (mutually exclusive with oldVariants)
  "oldOneTimeVariants": [789],          // one-time variants to remove
  "newVariants": { "123": 2 },         // variant ID → quantity to add
  "newOneTimeVariants": { "456": 1 },  // one-time variant ID → quantity
  "stopSwapEmails": false,
  "carryForwardDiscount": "COUPON_CODE"
}
```
- **Response**: `200 OK` with updated contract JSON
- **Response shape**:
```json
{
  "id": "gid://shopify/SubscriptionContract/123456",
  "status": "ACTIVE",
  "lines": {
    "nodes": [
      {
        "id": "gid://shopify/SubscriptionLine/...",
        "title": "Product Name",
        "variantTitle": "Flavor",
        "quantity": 1,
        "variantId": "gid://shopify/ProductVariant/123",
        "productId": "gid://shopify/Product/456",
        "sku": "SKU-001",
        "currentPrice": { "amount": "29.99", "currencyCode": "USD" },
        "variantImage": { "transformedSrc": "https://..." },
        "sellingPlanName": "Deliver every month"
      }
    ]
  },
  "deliveryPrice": { "amount": "0.00", "currencyCode": "USD" },
  "billingPolicy": { "interval": "MONTH", "intervalCount": 1 },
  "nextBillingDate": "2026-04-15T00:00:00Z"
}
```
- **Important**: Response may or may not include `lines` depending on whether Appstle processes synchronously. When `lines` is missing, the mutation was queued async — a webhook will follow.
- **Used in**: `src/lib/portal/handlers/replace-variants.ts`

## Coupon / Discount

### Apply Discount
```
PUT /api/external/v2/subscription-contracts-apply-discount?contractId={id}&discountCode={code}
```
- **Response**: `200 OK` or `204 No Content` (no meaningful body)
- **Error codes**: `409` conflict, `404` not found, `422` invalid/expired, `400` bad request
- **Used in**: portal coupon handler, journey complete, AI multi-turn

### Remove Discount
```
PUT /api/external/v2/subscription-contracts-remove-discount?contractId={id}&discountId={gid}
```
- **Response**: `200 OK` or `204 No Content` (no meaningful body)
- **Error codes**: `404` not found, `422` not removable
- **Used in**: portal coupon handler, journey complete, AI multi-turn

### Get Raw Contract (includes discounts)
```
GET /api/external/v2/contract-raw-response?contractId={id}&api_key={key}
```
- **Response**: `200 OK` with full Shopify contract JSON
- **Response shape** (relevant fields):
```json
{
  "discounts": {
    "nodes": [
      { "id": "gid://shopify/SubscriptionManualDiscount/...", "title": "COUPON_CODE" }
    ]
  },
  "lines": { "nodes": [...] },
  "status": "ACTIVE"
}
```
- **Used in**: AI multi-turn (check existing coupons before apply), journey complete

## Billing / Dunning

### Get Upcoming Orders
```
GET /api/external/v2/subscription-billing-attempts/top-orders?contractId={id}
```
- **Response**: `200 OK` with JSON array
- **Response shape**:
```json
[
  { "id": "123", "billingDate": "2026-04-15T00:00:00Z", "status": "SCHEDULED" }
]
```
- **Used in**: `src/lib/appstle.ts` → `appstleGetUpcomingOrders()`

### Attempt Billing
```
PUT /api/external/v2/subscription-billing-attempts/attempt-billing/{billingAttemptId}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleAttemptBilling()`

### Skip Upcoming Order
```
PUT /api/external/v2/subscription-billing-attempts/skip-upcoming-order?contractId={id}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSkipUpcomingOrder()`

### Unskip Order
```
PUT /api/external/v2/subscription-billing-attempts/unskip-order/{billingAttemptId}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleUnskipOrder()`

## Payment

### Switch Payment Method
```
PUT /api/external/v2/subscription-contracts-update-existing-payment-method?contractId={id}&paymentMethodId={gid}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSwitchPaymentMethod()`

### Send Payment Update Email
```
PUT /api/external/v2/subscription-contracts-update-payment-method?contractId={id}
```
- **Response**: `204 No Content` (no body)
- **Used in**: `src/lib/appstle.ts` → `appstleSendPaymentUpdateEmail()`

## Webhooks (Inbound from Appstle)

Appstle sends webhooks via Svix. Headers use `webhook-*` prefix (not `svix-*`).
Endpoint: `/api/webhooks/appstle/[workspaceId]`

### Subscription Events (rich payload with `data.customer`)
Event types: `subscription.created`, `subscription.activated`, `subscription.paused`, `subscription.cancelled`, `subscription.updated`, `subscription.billing-interval-changed`, `subscription.next-order-date-changed`, `subscription.upcoming-order-notification`

**Payload shape**:
```json
{
  "type": "subscription.updated",
  "data": {
    "id": "gid://shopify/SubscriptionContract/123",
    "status": "ACTIVE",
    "customer": {
      "id": "gid://shopify/Customer/456",
      "email": "user@example.com",
      "firstName": "...", "lastName": "...", "phone": "..."
    },
    "lines": {
      "nodes": [
        {
          "title": "Product", "sku": "SKU-001", "quantity": 1,
          "currentPrice": { "amount": "29.99" },
          "productId": "gid://shopify/Product/789",
          "variantId": "gid://shopify/ProductVariant/012",
          "variantTitle": "Flavor",
          "sellingPlanName": "Deliver every month"
        }
      ]
    },
    "billingPolicy": { "interval": "MONTH", "intervalCount": 1 },
    "deliveryPrice": { "amount": "5.99" },
    "deliveryMethod": {
      "address": {
        "firstName": "...", "lastName": "...",
        "address1": "...", "address2": "...",
        "city": "...", "province": "...", "provinceCode": "CA",
        "zip": "90210", "country": "United States", "countryCodeV2": "US"
      }
    },
    "nextBillingDate": "2026-04-15T00:00:00Z",
    "lastPaymentStatus": "SUCCEEDED",
    "createdAt": "2026-01-01T00:00:00Z"
  }
}
```

### Billing Events (flat payload with `data.contractId`, no `data.customer`)
Event types: `subscription.billing-success`, `subscription.billing-failure`, `subscription.billing-skipped`

**Payload shape**:
```json
{
  "type": "subscription.billing-failure",
  "data": {
    "contractId": "123456",
    "billingAttemptId": "789",
    "attemptCount": 1,
    "status": "FAILED",
    "billingAttemptResponseMessage": "{\"error_code\":\"CARD_DECLINED\",\"error_message\":\"Your card was declined.\"}"
  }
}
```

## Key Notes

- Most mutation endpoints return `204 No Content` with no body
- `replace-variants-v3` is the exception — returns `200` with updated contract JSON (but `lines` may be absent if processed async)
- Coupon endpoints return `200`/`204` on success but use specific HTTP status codes for errors (409, 404, 422, 400)
- `contract-raw-response` is a GET that returns the full Shopify subscription contract including discount nodes
- All endpoints accept both `200` and `204` as success (our code checks `!res.ok && res.status !== 204`)
- Webhook signature verification uses Svix library with `webhook-*` header prefix
