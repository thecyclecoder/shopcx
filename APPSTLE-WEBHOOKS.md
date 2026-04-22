# Appstle Webhook Payloads

Reference for all Appstle subscription webhooks used in the billing forecast system.

## De-duplication Warning

A single billing event can trigger multiple webhooks simultaneously. For example, a successful billing fires:
- `subscription.billing-success`
- `subscription.updated`
- `subscription.next-order-date-changed`

The forecast system must only act on the primary event (`billing-success` or `billing-failure`) and ignore the cascaded updates. Use `contractId + billingDate` or `billingAttemptId` as idempotency keys.

---

## subscription.created

Fired when a new subscription is created (checkout completed).

```json
{
  "data": {
    "__typename": "SubscriptionContract",
    "id": "gid://shopify/SubscriptionContract/33549975725",
    "status": "ACTIVE",
    "createdAt": "2026-04-22T02:59:45Z",
    "updatedAt": "2026-04-22T02:59:50Z",
    "nextBillingDate": "2026-05-19T08:00:00Z",
    "billingPolicy": {
      "interval": "WEEK",
      "intervalCount": 4,
      "anchors": []
    },
    "deliveryPolicy": {
      "interval": "WEEK",
      "intervalCount": 4,
      "anchors": []
    },
    "deliveryPrice": {
      "amount": "4.95",
      "currencyCode": "USD"
    },
    "customer": {
      "id": "gid://shopify/Customer/9808350642349",
      "displayName": "Jason Andrew Carter",
      "email": "jcfamily596+hai@gmail.com",
      "firstName": "Jason Andrew",
      "lastName": "Carter"
    },
    "customerPaymentMethod": {
      "id": "gid://shopify/CustomerPaymentMethod/28b85a763b5315ff2900ca589d8ee36f",
      "instrument": {
        "__typename": "CustomerCreditCard",
        "brand": "american_express",
        "lastDigits": "6875",
        "expiryMonth": 4,
        "expiryYear": 2031,
        "billingAddress": {
          "address1": "210 Executive Dr, Suite 7",
          "city": "Newark",
          "countryCode": "US",
          "provinceCode": "DE",
          "zip": "19702"
        }
      }
    },
    "deliveryMethod": {
      "__typename": "SubscriptionDeliveryMethodShipping",
      "address": {
        "address1": "210 Executive Dr, Suite 7",
        "city": "Newark",
        "country": "United States",
        "countryCode": "US",
        "provinceCode": "DE",
        "zip": "19702",
        "firstName": "Jason Andrew",
        "lastName": "Carter"
      }
    },
    "discounts": {
      "nodes": [
        {
          "id": "gid://shopify/SubscriptionManualDiscount/37ad7f56-...",
          "targetType": "LINE_ITEM",
          "title": "Buy 3 Discount",
          "type": "AUTOMATIC_DISCOUNT",
          "value": { "percentage": 12 }
        },
        {
          "id": "gid://shopify/SubscriptionManualDiscount/76a465ad-...",
          "targetType": "LINE_ITEM",
          "title": "FLOWERS",
          "type": "CODE_DISCOUNT",
          "recurringCycleLimit": 1,
          "rejectionReason": "USAGE_LIMIT_REACHED",
          "value": { "percentage": 22 }
        },
        {
          "id": "gid://shopify/SubscriptionManualDiscount/da6325b2-...",
          "targetType": "SHIPPING_LINE",
          "title": "Free Shipping on Subscriptions",
          "type": "AUTOMATIC_DISCOUNT",
          "value": { "percentage": 100 }
        }
      ]
    },
    "lines": {
      "nodes": [
        {
          "id": "gid://shopify/SubscriptionLine/3cb21132-...",
          "title": "Superfood Tabs",
          "variantTitle": "Strawberry Lemonade",
          "sku": "SC-TABS-SL-2",
          "productId": "gid://shopify/Product/7465708093613",
          "variantId": "gid://shopify/ProductVariant/42614433480877",
          "quantity": 3,
          "currentPrice": { "amount": "59.96", "currencyCode": "USD" },
          "lineDiscountedPrice": { "amount": "158.31", "currencyCode": "USD" },
          "pricingPolicy": {
            "basePrice": { "amount": "79.95" },
            "cycleDiscounts": [
              {
                "adjustmentType": "PERCENTAGE",
                "adjustmentValue": { "percentage": 25.0 },
                "afterCycle": 0,
                "computedPrice": { "amount": "59.96" }
              }
            ]
          },
          "sellingPlanName": "Delivered Monthly"
        }
      ]
    },
    "originOrder": {
      "id": "gid://shopify/Order/6892409946285",
      "name": "SC128487"
    }
  },
  "type": "subscription.created"
}
```

**Key fields for forecasting:**
- `data.id` → contract GID (parse numeric ID: `33549975725`)
- `data.nextBillingDate` → first renewal date
- `data.lines.nodes[].currentPrice.amount` → per-unit price
- `data.lines.nodes[].quantity` → quantity
- `data.lines.nodes[].lineDiscountedPrice.amount` → total after discounts
- `data.customer.id` → Shopify customer GID
- `data.customer.email` → customer email
- `data.billingPolicy.interval` + `intervalCount` → billing frequency
- `data.discounts.nodes[]` → active discounts

---

## subscription.billing-success

Fired when a subscription renewal is successfully billed.

```json
{
  "data": {
    "attemptCount": 1,
    "attemptTime": "2026-04-22T18:06:58Z",
    "billingAttemptId": "gid://shopify/SubscriptionBillingAttempt/157456203949",
    "billingDate": "2026-04-22T18:05:15Z",
    "contractId": 29905485997,
    "graphOrderId": "gid://shopify/Order/6893428015277",
    "id": 201097431,
    "inventorySkippedRetryingNeeded": false,
    "lastShippingUpdatedAt": "2026-04-22T17:28:45Z",
    "orderAmount": 74.54,
    "orderAmountContractCurrency": 74.54,
    "orderAmountUSD": 74.54,
    "orderId": 6893428015277,
    "orderName": "SC128525",
    "retryingNeeded": true,
    "shop": "2c6b02-3.myshopify.com",
    "status": "SUCCESS",
    "upcomingOrderEmailSentStatus": "EMAIL_SETTINGS_DISABLED"
  },
  "type": "subscription.billing-success"
}
```

**Key fields for forecasting:**
- `data.contractId` → subscription contract ID (numeric)
- `data.orderAmount` → revenue collected (dollars, not cents)
- `data.orderName` → order number (e.g., "SC128525")
- `data.orderId` → Shopify order ID
- `data.billingDate` → when it was billed
- `data.attemptCount` → which attempt succeeded (1 = first try)
- `data.status` → "SUCCESS"

---

## subscription.billing-failure

Fired when a subscription renewal fails to bill.

```json
{
  "data": {
    "attemptCount": 1,
    "attemptTime": "2026-04-22T18:23:25Z",
    "billingAttemptId": "gid://shopify/SubscriptionBillingAttempt/157456728237",
    "billingAttemptResponseMessage": "{\"admin_graphql_api_order_id\":null,\"error_message\":\"The payment couldn't be processed for technical reasons\",\"admin_graphql_api_subscription_contract_id\":\"gid://shopify/SubscriptionContract/27910340781\",\"ready\":true,\"admin_graphql_api_id\":\"gid://shopify/SubscriptionBillingAttempt/157456728237\",\"idempotency_key\":\"01e036d3-4e75-480c-88bb-6cb3915fd47d_210504894\",\"error_code\":\"unexpected_error\",\"id\":157456728237,\"order_id\":null,\"subscription_contract_id\":27910340781}",
    "billingDate": "2026-04-22T18:23:19Z",
    "contractId": 27910340781,
    "id": 210504894,
    "inventorySkippedRetryingNeeded": false,
    "retryingNeeded": false,
    "shop": "2c6b02-3.myshopify.com",
    "status": "SKIPPED_DUNNING_MGMT",
    "transactionFailedEmailSentStatus": "SENT",
    "transactionFailedSmsSentStatus": "PHONE_NUMBER_EMPTY"
  },
  "type": "subscription.billing-failure"
}
```

**Key fields for forecasting:**
- `data.contractId` → subscription contract ID (numeric)
- `data.billingDate` → when billing was attempted
- `data.status` → "SKIPPED_DUNNING_MGMT" (we handle dunning)
- `data.billingAttemptResponseMessage` → JSON string with `error_code` and `error_message`
- `data.attemptCount` → which attempt failed
- `data.retryingNeeded` → false (we manage retries)

---

## subscription.billing-skipped

Fired alongside billing-failure when the order is skipped (same payload shape as billing-failure). This is a cascaded event — **ignore for forecasting** since billing-failure already handles it.

```json
{
  "data": {
    "attemptCount": 1,
    "attemptTime": "2026-04-22T18:23:25Z",
    "billingAttemptId": "gid://shopify/SubscriptionBillingAttempt/157456728237",
    "billingAttemptResponseMessage": "{...same as billing-failure...}",
    "billingDate": "2026-04-22T18:23:19Z",
    "contractId": 27910340781,
    "id": 210504894,
    "inventorySkippedRetryingNeeded": false,
    "retryingNeeded": false,
    "shop": "2c6b02-3.myshopify.com",
    "status": "SKIPPED_DUNNING_MGMT"
  },
  "type": "subscription.billing-skipped"
}
```

**Action:** No-op for forecast — deduplicate with billing-failure using `billingAttemptId`.

---

## subscription.billing-interval-changed

Fired when billing frequency is changed (e.g., monthly → every 2 months). Full contract payload — same shape as `subscription.created`.

```json
{
  "data": {
    "id": "gid://shopify/SubscriptionContract/27944845485",
    "status": "ACTIVE",
    "nextBillingDate": "2026-05-14T08:00:00Z",
    "billingPolicy": {
      "interval": "WEEK",
      "intervalCount": 8
    },
    "customer": {
      "id": "gid://shopify/Customer/7060580008109",
      "email": "kimckavanagh@aol.com"
    },
    "lines": {
      "nodes": [
        {
          "sku": "Insure01",
          "title": "Shipping Protection",
          "quantity": 1,
          "currentPrice": { "amount": "6.0" }
        },
        {
          "sku": "SC-TABS-SL-2",
          "title": "Superfood Tabs",
          "variantTitle": "Strawberry Lemonade",
          "quantity": 2,
          "currentPrice": { "amount": "59.96" },
          "lineDiscountedPrice": { "amount": "119.92" }
        }
      ]
    }
  },
  "type": "subscription.billing-interval-changed"
}
```

**Key fields for forecasting:**
- `data.id` → contract GID
- `data.nextBillingDate` → may have shifted due to interval change
- `data.billingPolicy.interval` + `intervalCount` → new frequency
- `data.lines` → items + prices (unchanged by interval change)
- **Forecast action:** If `nextBillingDate` changed, move the forecast entry to the new date. Recalculate future expected dates based on new interval.

---

## subscription.cancelled

Fired when a subscription is cancelled. Full contract payload — same shape as `subscription.created` but with `status: "CANCELLED"`.

```json
{
  "data": {
    "id": "gid://shopify/SubscriptionContract/32984400045",
    "status": "CANCELLED",
    "nextBillingDate": "2026-05-18T08:00:00Z",
    "createdAt": "2026-03-24T02:20:16Z",
    "updatedAt": "2026-04-22T16:57:22Z",
    "billingPolicy": {
      "interval": "WEEK",
      "intervalCount": 4
    },
    "customer": {
      "id": "gid://shopify/Customer/9539164569773",
      "email": "msamuel1919@yahoo.com",
      "firstName": "Margaret",
      "lastName": "Samuel"
    },
    "lines": {
      "nodes": [
        {
          "sku": "SC-INSTANTCO-COCOA",
          "title": "Amazing Coffee",
          "variantTitle": "Cocoa French Roast",
          "quantity": 1,
          "currentPrice": { "amount": "59.96" },
          "lineDiscountedPrice": { "amount": "55.17" }
        },
        {
          "sku": "ST-GUMMY-3",
          "title": "ACV Gummies",
          "quantity": 1,
          "currentPrice": { "amount": "0.0" },
          "customAttributes": [
            { "key": "_appstle-free-product", "value": "true" }
          ]
        },
        {
          "sku": "SC-CREAMER-CARAMEL",
          "title": "Amazing Creamer",
          "variantTitle": "Salted Caramel",
          "quantity": 1,
          "currentPrice": { "amount": "52.46" },
          "lineDiscountedPrice": { "amount": "48.27" }
        }
      ]
    },
    "discounts": {
      "nodes": [
        {
          "title": "Buy 2 Discount",
          "type": "AUTOMATIC_DISCOUNT",
          "value": { "percentage": 8 }
        },
        {
          "title": "Free Shipping on Subscriptions",
          "type": "AUTOMATIC_DISCOUNT",
          "value": { "percentage": 100 }
        }
      ]
    },
    "originOrder": {
      "id": "gid://shopify/Order/6822208143533",
      "name": "SC125999"
    }
  },
  "type": "subscription.cancelled"
}
```

**Key fields for forecasting:**
- `data.id` → contract GID (parse numeric: `32984400045`)
- `data.status` → "CANCELLED"
- `data.nextBillingDate` → the billing date that will now NOT happen
- **Forecast action:** Mark the pending forecast entry as `cancelled`. Remove expected revenue from that date.

---

## subscription.next-order-date-changed

Fired when the next billing date is changed (customer or system). Full contract payload — same shape as `subscription.created`.

```json
{
  "data": {
    "id": "gid://shopify/SubscriptionContract/29905485997",
    "status": "ACTIVE",
    "nextBillingDate": "2026-05-20T18:05:15Z",
    "billingPolicy": {
      "interval": "WEEK",
      "intervalCount": 4
    },
    "customer": {
      "id": "gid://shopify/Customer/8193316913325",
      "email": "smp0609@yahoo.com"
    },
    "lines": { "nodes": ["...same as created..."] }
  },
  "type": "subscription.next-order-date-changed"
}
```

**Key fields:** Same as created. Compare `nextBillingDate` against stored forecast.
**Forecast action:** Update the pending forecast's expected_date to the new `nextBillingDate`.
**Dedup note:** Often fires alongside `billing-success` (Appstle auto-advances the date). Skip if billing-success already created a new forecast.

---

## subscription.paused

Fired when a subscription is paused. Appstle pauses are indefinite — our DB tracks when to resume (`pause_resume_at` or crisis `auto_resume`).

```json
{
  "data": {
    "id": "gid://shopify/SubscriptionContract/27833565357",
    "status": "PAUSED",
    "nextBillingDate": "2026-04-24T07:00:00Z",
    "customer": {
      "id": "gid://shopify/Customer/7060796276909",
      "email": "crashg@speedfreaks.tv"
    },
    "lines": { "nodes": ["..."] }
  },
  "type": "subscription.paused"
}
```

**Forecast action:** Mark pending forecast as `paused`. Cross-reference `subscriptions.pause_resume_at` or `crisis_customer_actions.auto_resume` in our DB to know if/when it comes back.

---

## subscription.activated

Fired when a subscription is resumed (paused → active) OR reactivated (cancelled → active).

```json
{
  "data": {
    "id": "gid://shopify/SubscriptionContract/27884191917",
    "status": "ACTIVE",
    "nextBillingDate": "2026-05-31T08:00:00Z",
    "customer": {
      "id": "gid://shopify/Customer/7060986364077",
      "email": "gerkenjeanie@yahoo.com"
    },
    "lines": { "nodes": ["..."] }
  },
  "type": "subscription.activated"
}
```

**Forecast action:** Create a new pending forecast on `nextBillingDate` with current items/prices (if no pending forecast exists).

---

## subscription.updated

Catch-all fired on any contract change (items, discounts, address, etc.). Also cascades alongside billing events, pause, cancel, activate.

```json
{
  "data": {
    "id": "gid://shopify/SubscriptionContract/27910340781",
    "status": "ACTIVE",
    "nextBillingDate": "2026-06-17T18:21:45Z",
    "lastPaymentStatus": "FAILED",
    "lines": { "nodes": ["...current items/prices..."] },
    "discounts": { "nodes": ["...current discounts..."] }
  },
  "type": "subscription.updated"
}
```

**Forecast action:** If a pending forecast exists, update its `expected_revenue_cents` based on current items/prices. **Skip entirely** if a primary event (`billing-success`, `billing-failure`, `cancelled`, `paused`, `activated`, `billing-interval-changed`, `next-order-date-changed`) already processed this contract within a short window.

---

## De-duplication Rule

**One pending forecast per subscription.** Never stack forecasts. When any event fires, find or create the single pending forecast for that contract and update it. A subscription's forecast lifecycle:

```
created/activated → pending
  ├── date changed → update date
  ├── item changed → update amount
  ├── interval changed → update date + recalc
  ├── paused → mark paused
  ├── cancelled → mark cancelled
  ├── billing-success → mark collected, create NEW pending for next date
  └── billing-failure → mark failed, dunning takes over
```
