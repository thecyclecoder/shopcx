# customers

Synced from Shopify. Email, retention_score, subscription_status, LTV, marketing consent. A 'lead' is a customer with no orders.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `email` | `text` | — |  |
| `first_name` | `text` | ✓ |  |
| `last_name` | `text` | ✓ |  |
| `phone` | `text` | ✓ |  |
| `shopify_customer_id` | `text` | ✓ |  |
| `stripe_customer_id` | `text` | ✓ |  |
| `retention_score` | `int4` | ✓ | default: `50` |
| `subscription_status` | `text` | ✓ | default: `'never'` |
| `subscription_tenure_days` | `int4` | ✓ | default: `0` |
| `total_orders` | `int4` | ✓ | default: `0` |
| `ltv_cents` | `int8` | ✓ | default: `0` |
| `first_order_at` | `timestamptz` | ✓ |  |
| `last_order_at` | `timestamptz` | ✓ |  |
| `tags` | `text[]` | ✓ | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `email_marketing_status` | `text` | ✓ | default: `'not_subscribed'` |
| `sms_marketing_status` | `text` | ✓ | default: `'not_subscribed'` |
| `default_address` | `jsonb` | ✓ |  |
| `addresses` | `jsonb` | ✓ | default: `'[]'` |
| `locale` | `text` | ✓ |  |
| `note` | `text` | ✓ |  |
| `shopify_state` | `text` | ✓ |  |
| `valid_email` | `bool` | ✓ | default: `true` |
| `shopify_created_at` | `timestamptz` | ✓ |  |
| `portal_banned` | `bool` | — | default: `false` |
| `portal_banned_at` | `timestamptz` | ✓ |  |
| `portal_banned_by` | `uuid` | ✓ |  |
| `timezone` | `text` | ✓ |  |
| `banned` | `bool` | — | default: `false` |
| `banned_at` | `timestamptz` | ✓ |  |
| `banned_reason` | `text` | ✓ |  |
| `chargeback_notice_sent_at` | `timestamptz` | ✓ |  |
| `segments` | `text[]` | — | default: `ARRAY[]` |
| `segments_refreshed_at` | `timestamptz` | ✓ |  |
| `phone_status` | `text` | ✓ |  |
| `phone_status_code` | `int4` | ✓ |  |
| `phone_status_at` | `timestamptz` | ✓ |  |
| `preferred_sms_send_hour` | `int2` | ✓ |  |
| `preferred_sms_send_hour_clicks` | `int2` | ✓ |  |
| `preferred_sms_send_hour_at` | `timestamptz` | ✓ |  |
| `short_code` | `varchar` | ✓ |  |
| `braintree_customer_id` | `text` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[appstle_api_calls]].`customer_id`
- [[auth_otp_sessions]].`customer_id`
- [[billing_forecasts]].`customer_id`
- [[cart_drafts]].`customer_id`
- [[chargeback_events]].`customer_id`
- [[chargeback_subscription_actions]].`customer_id`
- [[crisis_customer_actions]].`customer_id`
- [[customer_demographics]].`customer_id`
- [[customer_events]].`customer_id`
- [[customer_link_rejections]].`customer_id`
- [[customer_link_rejections]].`rejected_customer_id`
- [[customer_links]].`customer_id`
- [[customer_payment_methods]].`customer_id`
- [[dunning_cycles]].`customer_id`
- [[email_events]].`customer_id`
- [[escalation_gaps]].`customer_id`
- [[fraud_action_log]].`customer_id`
- [[fraud_rule_matches]].`customer_id`
- [[journey_sessions]].`customer_id`
- [[klaviyo_profile_directory]].`customer_id`
- [[klaviyo_profile_staging]].`customer_id`
- [[loyalty_members]].`customer_id`
- [[marketing_shortlink_clicks]].`customer_id`
- [[meta_sender_customer_links]].`customer_id`
- [[orders]].`customer_id`
- [[payment_failures]].`customer_id`
- [[product_reviews]].`customer_id`
- [[profile_engagement_summary]].`customer_id`
- [[profile_events]].`customer_id`
- [[remedy_outcomes]].`customer_id`
- [[replacements]].`customer_id`
- [[returns]].`customer_id`
- [[sms_campaign_recipients]].`customer_id`
- [[social_comments]].`customer_id`
- [[store_credit_log]].`customer_id`
- [[storefront_events]].`customer_id`
- [[storefront_leads]].`customer_id`
- [[storefront_sessions]].`customer_id`
- [[subscriptions]].`customer_id`
- [[tickets]].`customer_id`
- [[transactions]].`customer_id`
- [[widget_sessions]].`customer_id`

## Common queries

### Find a customer by Shopify id (primary lookup)
```ts
const { data: customer } = await admin.from("customers")
  .select("id, email, retention_score, subscription_status, ltv_cents")
  .eq("workspace_id", workspaceId)
  .eq("shopify_customer_id", shopifyCustomerId)
  .maybeSingle();
```

### Find by email as fallback
```ts
const { data } = await admin.from("customers")
  .select("id, shopify_customer_id")
  .eq("workspace_id", workspaceId)
  .ilike("email", email).maybeSingle();
```

### Marketing-eligible customers
```ts
const { data } = await admin.from("customers")
  .select("id, email, phone")
  .eq("workspace_id", workspaceId)
  .eq("email_marketing_status", "subscribed");   // lowercase!
```

### Active subscribers
```ts
const { data } = await admin.from("customers")
  .select("id, email")
  .eq("workspace_id", workspaceId)
  .eq("subscription_status", "active");
```

### Get the linked-account group for a customer
```ts
// See DATABASE.md linkedIds() — always expand the group before scoping queries.
```

## Gotchas

- `email_marketing_status` / `sms_marketing_status`: `"subscribed"`, `"unsubscribed"`, `"not_subscribed"`, or `null`. Lowercase.
- `subscription_status`: `"active"`, `"cancelled"`, `"never"`, `"paused"`. `"never"` = a lead (no orders yet).
- Customers can be linked. To get a customer's full history, expand to linked group first (see `customer_links`).
- A lead IS a customer (no orders, `subscription_status='never'`). No parallel `leads` table.
- `banned` (storefront ban) vs `portal_banned` (customer portal ban) are different flags.
- Email is the matching key but **`shopify_customer_id` is the primary lookup** — match by it first, fall back to email. See feedback_shopify_id_primary.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
