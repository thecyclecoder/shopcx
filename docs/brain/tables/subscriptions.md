# subscriptions

Synced from Appstle. items JSONB, billing interval, next billing date. Will become source of truth post-Appstle.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `shopify_contract_id` | `text` | — |  |
| `status` | `text` | — | default: `'active'` |
| `billing_interval` | `text` | ✓ |  |
| `billing_interval_count` | `int4` | ✓ |  |
| `next_billing_date` | `timestamptz` | ✓ |  |
| `last_payment_status` | `text` | ✓ |  |
| `items` | `jsonb` | ✓ | default: `'[]'` |
| `delivery_price_cents` | `int8` | ✓ | default: `0` |
| `shopify_customer_id` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `consecutive_skips` | `int4` | ✓ | default: `0` |
| `pause_resume_at` | `timestamptz` | ✓ |  |
| `shipping_address` | `jsonb` | ✓ |  |
| `subscription_created_at` | `timestamptz` | ✓ |  |
| `applied_discounts` | `jsonb` | — | default: `'[]'` |
| `is_internal` | `bool` | — | default: `false` |
| `shipping_protection_added` | `bool` | — | default: `false` |
| `shipping_protection_amount_cents` | `int4` | ✓ |  |
| `shipping_method_code` | `text` | ✓ | default: `'economy'` |
| `shipping_rate_id` | `uuid` | ✓ | → [[shipping_rates]].id |
| `avalara_quote_tax_cents` | `int4` | ✓ |  |
| `avalara_quote_total_cents` | `int4` | ✓ |  |
| `avalara_quote_at` | `timestamptz` | ✓ |  |
| `avalara_quote_address` | `jsonb` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `shipping_rate_id` → [[shipping_rates]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[billing_forecasts]].`subscription_id`
- [[chargeback_subscription_actions]].`subscription_id`
- [[crisis_customer_actions]].`subscription_id`
- [[dunning_cycles]].`subscription_id`
- [[fraud_action_log]].`subscription_id`
- [[journey_sessions]].`subscription_id`
- [[orders]].`subscription_id`
- [[payment_failures]].`subscription_id`
- [[remedy_outcomes]].`subscription_id`
- [[replacements]].`subscription_id`
- [[transactions]].`subscription_id`

## Common queries

### Customer's truly-active subscriptions
```ts
const ids = await linkedIds(admin, customerId);
const { data: subs } = await admin.from("subscriptions")
  .select("id, shopify_contract_id, status, items, billing_interval, next_billing_date, delivery_price_cents")
  .in("customer_id", ids)
  .eq("status", "active");   // lowercase
```

### Lookup by internal sub UUID (preferred for internal joins)
```ts
const { data } = await admin.from("subscriptions")
  .select("*").eq("id", subscriptionId).maybeSingle();
```

### All paused subscriptions in a workspace
```ts
const { data } = await admin.from("subscriptions")
  .select("id, customer_id, pause_resume_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "paused");
```

### Subs auto-billing in the next 7 days
```ts
const soon = new Date(Date.now() + 7*86400e3).toISOString();
const { data } = await admin.from("subscriptions")
  .select("id, customer_id, next_billing_date, delivery_price_cents, items")
  .eq("workspace_id", workspaceId)
  .eq("status", "active")
  .lte("next_billing_date", soon);
```

### When was this sub cancelled? (event log, NOT a column)
```ts
const { data } = await admin.from("customer_events")
  .select("created_at, properties")
  .eq("event_type", "subscription.cancelled")
  .contains("properties", { subscription_id: subId })
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
```

## Gotchas

- `status` is **lowercase**: `"active"`, `"paused"`, `"cancelled"`. `.eq("status", "ACTIVE")` returns zero rows.
- No `cancelled_at` / `paused_at` columns — the timestamp lives in `customer_events`. To know *when* a sub was cancelled, query the event log.
- **Internal joins ALWAYS use the UUID.** `id` (UUID) joins to `dunning_cycles.subscription_id`, `payment_failures.subscription_id`, `orders.subscription_id`, etc. `shopify_contract_id` + `shopify_customer_id` are Shopify-boundary fields ONLY — webhook ingest, Shopify API calls. Never use them as join keys between internal tables. They'll be deprecated once we sunset Shopify.
- Always include linked customers — use `linkedIds(customerId)` helper, then `.in("customer_id", ids)`.
- `items` is JSONB — variant ids live inside, not on a join table. Use `items->0->>'variantId'`.
- **Internal-sub items are catalog references, not prices.** Each line is `{ variant_id (product_variants.id UUID), product_id (UUID), title, variant_title, sku, quantity, line_id, price_override_cents? }`. The price is **derived live** by the pricing engine ([[../libraries/pricing]]) from the catalog + [[pricing_rules]] — never baked. `price_override_cents` is the only price an internal sub carries, and only for grandfathered lines. A baked `price_cents` is legacy; mutations strip it. (Appstle subs are unchanged — they keep Appstle/Shopify-baked prices and Shopify variant ids.)

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
