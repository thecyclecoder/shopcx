# Smile.io Loyalty API Reference

Smile.io is our loyalty/rewards provider. This documents the API for integration.

Base URL: `https://api.smile.io/v1`

## Authentication

```
Authorization: Bearer {api_secret}
```

Two key types available in Smile admin (Settings > API credentials):
- **Secret API key** — Full access, server-side only. This is what we use.
- **Publishable API key** — Client-side safe, limited scope (widget/SDK).

## Customers / Members

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/customers` | List customers (paginated). Filter by `email`, `external_id` (Shopify customer ID). |
| `GET` | `/customers/:id` | Get by Smile.io internal ID |
| `POST` | `/customers` | Create. Body: `{ email, first_name, last_name, external_id }` |
| `PUT` | `/customers/:id` | Update attributes |

**Lookup by Shopify customer ID:**
```
GET /customers?external_id=7654321
```

**Customer object shape:**
```json
{
  "id": "smile_id",
  "email": "user@example.com",
  "first_name": "Dylan",
  "last_name": "Ralston",
  "external_id": "7033325191341",
  "points_balance": 2400,
  "points_earned": 5000,
  "points_spent": 2600,
  "referral_url": "https://store.com/ref/abc123",
  "vip_tier_id": "tier_id",
  "state": "member",
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-03-30T00:00:00Z"
}
```

## Points Transactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/points_transactions` | List transactions. Filter by `customer_id`. |
| `POST` | `/points_transactions` | Award or deduct points |

**Award points:**
```json
POST /points_transactions
{
  "points_transaction": {
    "customer_id": "smile_customer_id",
    "points_change": 500,
    "description": "Bonus points for loyalty"
  }
}
```

**Deduct points (negative value):**
```json
POST /points_transactions
{
  "points_transaction": {
    "customer_id": "smile_customer_id",
    "points_change": -200,
    "description": "Manual adjustment"
  }
}
```

Transaction `type` field: `earning`, `spending`, `adjustment`, `expiry`

## Points Products (Earning Rules)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/points_products` | List earning rules (e.g., "5pts per $1 spent", "Birthday bonus") |
| `GET` | `/points_products/:id` | Get single rule |

Shape: `{ id, name, reward_type, points_value, exchange_type, is_active }`

## Rewards (Redemption Catalog)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/rewards` | List all available rewards |
| `GET` | `/rewards/:id` | Get single reward |

**Reward object shape:**
```json
{
  "id": "reward_id",
  "name": "$10 Off",
  "description": "Get $10 off your next order",
  "points_price": 1000,
  "reward_type": "discount_code",
  "discount_value": 10,
  "discount_type": "fixed_amount",
  "is_active": true
}
```

`reward_type`: `discount_code`, `free_product`, `free_shipping`
`discount_type`: `fixed_amount`, `percentage`

## Reward Fulfillments (Redemptions)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/reward_fulfillments` | List redemptions. Filter by `customer_id`. |
| `POST` | `/reward_fulfillments` | Redeem a reward for a customer |

**Redeem:**
```json
POST /reward_fulfillments
{
  "reward_fulfillment": {
    "customer_id": "smile_customer_id",
    "reward_id": "reward_id"
  }
}
```

**Response includes the generated Shopify discount code:**
```json
{
  "id": "fulfillment_id",
  "customer_id": "smile_id",
  "reward_id": "reward_id",
  "code": "SMILE-ABC123",
  "points_spent": 1000,
  "state": "fulfilled"
}
```

## Referrals

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/referrals` | List. Filter by `referrer_customer_id` or `referred_customer_id`. |
| `GET` | `/referrals/:id` | Get single referral |

Shape: `{ id, referrer_customer_id, referred_customer_id, state, created_at }`
States: `pending`, `completed`, `rewarded`

Referral URLs are auto-generated per customer (`referral_url` on customer object). Points awarded automatically when referred customer places an order.

## VIP Tiers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/vip_tiers` | List all tiers |
| `GET` | `/vip_tiers/:id` | Get single tier |

**Tier object shape:**
```json
{
  "id": "tier_id",
  "name": "Gold",
  "description": "Top tier customers",
  "minimum_points": 5000,
  "multiplier": 2,
  "perks": ["Free shipping", "Early access"],
  "position": 2
}
```

Tier progression is automatic. Customer's current tier is on `vip_tier_id`.

## Activity Feed

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/activities` | Unified feed. Filter by `customer_id`. |

`activity_type`: `points_earned`, `points_redeemed`, `referral_completed`, `vip_tier_changed`

## Webhooks

Configure in Smile admin (Settings > Webhooks) or via API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/webhooks` | List registered webhooks |
| `POST` | `/webhooks` | Create webhook |
| `DELETE` | `/webhooks/:id` | Delete webhook |

**Available topics:**
- `customer/created`
- `customer/updated`
- `points_transaction/created`
- `reward_fulfillment/created`
- `referral/completed`
- `vip_tier/changed`

**Create:**
```json
POST /webhooks
{
  "webhook": {
    "topic": "points_transaction/created",
    "address": "https://shopcx.ai/api/webhooks/smile"
  }
}
```

Signature verification via `X-Smile-Hmac-SHA256` header (similar to Shopify HMAC pattern).

## Pagination

```
GET /customers?page=1&per_page=50
```

Response:
```json
{
  "customers": [...],
  "metadata": {
    "page": 1,
    "per_page": 50,
    "total_count": 1234,
    "total_pages": 25
  }
}
```

Default 25, max 250 per page.

## Rate Limits

- Standard plans: ~40 requests per 10 seconds (4 req/sec)
- 429 Too Many Requests with `Retry-After` header
- Enterprise plans have higher limits

## Shopify Integration Notes

- **External ID** = Shopify customer ID. Primary lookup key.
- **Auto order earning**: Smile.io auto-awards points on Shopify order completion. No API call needed for standard earning.
- **Discount codes**: Reward redemptions create real Shopify discount codes, returned in the fulfillment response.
- **Customer sync**: Smile.io auto-syncs from Shopify. Set `external_id` when creating via API to avoid dupes.

## ShopCX Integration Opportunities

1. **Customer sidebar**: Show points balance, VIP tier, referral URL (lookup via `external_id` = shopify_customer_id)
2. **Cancel journey retention**: "You have 2,400 points worth $24 — don't lose them!" as a save lever
3. **AI agent context**: Include loyalty status so AI can reference points/tier in conversations
4. **Reward redemption**: Agents could trigger redemptions from ticket sidebar
5. **Webhooks**: `points_transaction/created` and `vip_tier/changed` to keep customer data fresh
6. **Portal**: Show points balance and redemption options in customer portal

## Caveat

Smile.io's API docs have been revised over time. Verify exact field names and nesting against https://docs.smile.io before building. The signing secret for webhooks is separate from the API key.
