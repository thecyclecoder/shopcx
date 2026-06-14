# orders

Synced from Shopify. line_items, fulfillments, financial/fulfillment status, attribution UTMs.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `shopify_order_id` | `text` | ✓ |  |
| `order_number` | `text` | ✓ |  |
| `email` | `text` | ✓ |  |
| `total_cents` | `int8` | ✓ | default: `0` |
| `currency` | `text` | ✓ | default: `'USD'` |
| `financial_status` | `text` | ✓ |  |
| `fulfillment_status` | `text` | ✓ |  |
| `line_items` | `jsonb` | ✓ | default: `'[]'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `source_name` | `text` | ✓ |  |
| `app_id` | `int8` | ✓ |  |
| `tags` | `text` | ✓ |  |
| `order_type` | `text` | ✓ |  |
| `fulfillments` | `jsonb` | ✓ | default: `'[]'` |
| `shopify_customer_id` | `text` | ✓ |  |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `shipping_address` | `jsonb` | ✓ |  |
| `normalized_shipping_address` | `text` | ✓ |  |
| `discount_codes` | `jsonb` | ✓ | default: `'[]'` |
| `amplifier_order_id` | `uuid` | ✓ |  |
| `amplifier_received_at` | `timestamptz` | ✓ |  |
| `amplifier_shipped_at` | `timestamptz` | ✓ |  |
| `amplifier_tracking_number` | `text` | ✓ |  |
| `amplifier_carrier` | `text` | ✓ |  |
| `amplifier_status` | `text` | ✓ |  |
| `sync_resolved_at` | `timestamptz` | ✓ |  |
| `sync_resolved_note` | `text` | ✓ |  |
| `delivery_status` | `text` | ✓ |  |
| `delivered_at` | `timestamptz` | ✓ |  |
| `easypost_status` | `text` | ✓ |  |
| `easypost_detail` | `text` | ✓ |  |
| `easypost_location` | `text` | ✓ |  |
| `easypost_checked_at` | `timestamptz` | ✓ |  |
| `billing_address` | `jsonb` | ✓ |  |
| `payment_details` | `jsonb` | ✓ |  |
| `landing_site` | `text` | ✓ |  |
| `referring_site` | `text` | ✓ |  |
| `attributed_utm_source` | `text` | ✓ |  |
| `attributed_utm_medium` | `text` | ✓ |  |
| `attributed_utm_campaign` | `text` | ✓ |  |
| `attributed_utm_content` | `text` | ✓ |  |
| `attributed_utm_term` | `text` | ✓ |  |
| `braintree_transaction_id` | `text` | ✓ |  |
| `braintree_payment_method_token` | `text` | ✓ |  |
| `braintree_customer_id` | `text` | ✓ |  |
| `cart_token` | `text` | ✓ |  |
| `shipping_protection_added` | `bool` | — | default: `false` |
| `shipping_protection_amount_cents` | `int4` | ✓ |  |
| `shipping_method_code` | `text` | ✓ |  |
| `shipping_rate_id` | `uuid` | ✓ | → [[shipping_rates]].id |
| `avalara_transaction_code` | `text` | ✓ |  |
| `avalara_total_tax_cents` | `int4` | ✓ |  |
| `avalara_committed_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `shipping_rate_id` → [[shipping_rates]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[cart_drafts]].`converted_order_id`
- [[replacements]].`original_order_id`
- [[replacements]].`replacement_order_id`
- [[returns]].`order_id`
- [[transactions]].`order_id`

## Common queries

### Customer's order history (across linked accounts)
```ts
const ids = await linkedIds(admin, customerId);
const { data: orders } = await admin.from("orders")
  .select("order_number, created_at, total_cents, line_items, financial_status")
  .in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Get one order with its transactions
```ts
const { data: order } = await admin.from("orders")
  .select("*").eq("order_number", "SC129467").maybeSingle();
const { data: txns } = await admin.from("transactions")
  .select("type, amount_cents, status, created_at, settled_at, refunded_at")
  .eq("order_id", order.id);
```

### Orders attributed to a Klaviyo campaign
```ts
const { data } = await admin.from("klaviyo_events")
  .select("customer_id, properties")
  .eq("attributed_klaviyo_campaign_id", campaignId);
```

### Orders by UTM campaign
```ts
const { data } = await admin.from("orders")
  .select("order_number, total_cents")
  .eq("workspace_id", workspaceId)
  .eq("attributed_utm_campaign", "founders_day_2026")
  .gte("created_at", since);
```

### Recent paid orders (head count only) — note mixed-case handling
```ts
const { count } = await admin.from("orders")
  .select("id", { count: "exact", head: true })
  .eq("workspace_id", workspaceId)
  .in("financial_status", ["PAID", "paid"])   // both cases exist in prod
  .gte("created_at", since);
```

## Gotchas

- There is no `name` column — use `order_number` (e.g. `"SC129467"`).
- There is no `processed_at` — use `created_at` for time-ordering.
- `shipping_address` and `billing_address` are both JSONB. If only one is populated on the Shopify side, both are mirrored — see feedback_address_mirror_rule.
- `line_items` is JSONB. Variant ids inside, not a join.
- `shopify_order_id` is a numeric string. Internal joins should use `id` (UUID), not the Shopify id.
- `financial_status`: **mixed-case in production data** — both `"PAID"` (94% of rows, from Shopify webhook ingestion) and `"paid"` (6%, normalized) exist. Same for `"REFUNDED"`/`"refunded"`, `"PARTIALLY_REFUNDED"`/`"partially_refunded"`, `"PENDING"`/`"pending"`. Use `ILIKE` or `.in("financial_status", ["PAID","paid"])`. Don't use `.eq("financial_status", "paid")` — you'll miss 94% of rows.
- `fulfillment_status`: `"fulfilled"`, `"partial"`, `"unfulfilled"`, or `null`. Probe before assuming lowercase.
- **`attributed_utm_*` / `landing_site` / `referring_site` are populated by two paths.** Shopify-webhook orders parse them from `landing_site` (`extractOrderUtms` in `shopify-webhooks.ts`). **Native storefront orders** (`source_name='storefront'`, created in `/api/checkout`) had these NULL until 2026-06-14 — they now backfill **first-touch** from the visitor's `storefront_sessions` (earliest session carrying a `utm_source`, by `customer_id` after the identity stitch). So a Meta-sourced storefront sale now shows `attributed_utm_source='meta'` on the order itself, no `storefront_sessions` join needed. Caveat: first-touch only resolves across sessions the visitor was identified in (cross-anonymous_id stitching isn't done) — a pure-anonymous Meta click that converts in a later direct session still attributes `(direct)`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
