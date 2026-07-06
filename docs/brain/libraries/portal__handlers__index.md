# libraries/portal/handlers/index

Portal handler dispatch table.

**File:** `src/lib/portal/handlers/index.ts`

## File header

```
Portal route handlers — ported from subscriptions-portal with ShopCX upgrades:
- DB-first lookups for subscriptions/detail
- Event logging for all mutations
- Cancel → journey instead of hard cancel
- Reviews from product_reviews table (not Klaviyo direct)
- Dunning awareness on subscription responses
- Internal ticket notes for agent visibility
```

## Exports

### `routeMap` — const

```ts
const routeMap: Record<string, RouteHandler>
```

### `bootstrap` — re-export from `./bootstrap`

### `home` — re-export from `./home`

### `subscriptions` — re-export from `./subscriptions`

### `subscriptionDetail` — re-export from `./subscription-detail`

### `pause` — re-export from `./pause`

### `resume` — re-export from `./resume`

### `cancel` — re-export from `./cancel`

### `reactivate` — re-export from `./reactivate`

### `address` — re-export from `./address`

### `replaceVariants` — re-export from `./replace-variants`

### `removeLineItem` — re-export from `./remove-line-item`

### `coupon` — re-export from `./coupon`

### `frequency` — re-export from `./frequency`

### `featuredReviews` — re-export from `./reviews`

### `cancelJourney` — re-export from `./cancel-journey`

### `dunningStatus` — re-export from `./dunning-status`

### `changeDate` — re-export from `./change-date`

### `orderNow` — re-export from `./order-now`

### `submitBanRequest` — re-export from `./ban-request`

### `loyaltyBalance` — re-export from `./loyalty-balance`

### `loyaltyRedeem` — re-export from `./loyalty-redeem`

### `loyaltyApplyToSubscription` — re-export from `./loyalty-apply-subscription`

### `linkAccounts` — re-export from `./link-accounts`

### `updateAccount` — re-export from `./account`

### `supportList` — re-export from `./support`

### `supportTicket` — re-export from `./support`

### `supportReply` — re-export from `./support`

### `supportCreate` — re-export from `./support`

### `paymentMethods` — re-export from `./payment-methods`

### `orderDetail` — re-export from `./order-detail`

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
