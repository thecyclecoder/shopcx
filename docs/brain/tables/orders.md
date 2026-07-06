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
| `easypost_tracking` | `jsonb` | ✓ | Cached EasyPost Tracker milestone events (structured `{ events: [{ status, message, datetime, tracking_location }] }`). Complements the plain-text `easypost_detail`. Populated by the portal order-detail delivery resolver ([[../specs/portal-order-detail-tracking-widget]] Phase 2) on internal (Shopify-order-id-null) shipments, throttled to once per UTC day; not written on Shopify-fulfilled orders (they use `fulfillments.trackingInfo` instead). |
| `billing_address` | `jsonb` | ✓ |  |
| `payment_details` | `jsonb` | ✓ |  |
| `landing_site` | `text` | ✓ |  |
| `referring_site` | `text` | ✓ |  |
| `attributed_utm_source` | `text` | ✓ |  |
| `attributed_utm_medium` | `text` | ✓ |  |
| `attributed_utm_campaign` | `text` | ✓ |  |
| `attributed_utm_content` | `text` | ✓ |  |
| `attributed_utm_term` | `text` | ✓ |  |
| `advertorial_page_id` | `uuid` | ✓ | → [[advertorial_pages]].id · FK `on delete set null`. Phase 2b — resolved lander identity persisted at checkout from the first-touch (or earliest lander) `storefront_sessions` row (`/api/checkout` § 10b). Lets attribution survive cross-session conversion without re-parsing `landing_site`. |
| `ad_campaign_id` | `uuid` | ✓ | → [[ad_campaigns]].id · FK `on delete set null`. Phase 2b — the resolved page's `campaign_id`, persisted alongside `advertorial_page_id`. |
| `braintree_transaction_id` | `text` | ✓ |  |
| `braintree_payment_method_token` | `text` | ✓ |  |
| `braintree_customer_id` | `text` | ✓ |  |
| `cart_token` | `text` | ✓ |  |
| `session_id` | `uuid` | ✓ | → [[storefront_sessions]].id · FK `on delete set null`. The first-class order↔session link ([[../lifecycles/storefront-session-attribution]] § 3). Written at `/api/checkout` (§ 10c) from the converting session it already resolves for the `order_placed` event. Replaces the old indirect hop (`cart_token` → `order_placed` event → `session_id`). Session-stamped experiment attribution joins it literally (`orders.session_id` → `storefront_sessions.experiment_assignments`); the order-detail Journey panel renders off it. Null for synced Shopify orders. Backfill: `scripts/backfill-order-session-link.ts`. |
| `anonymous_id` | `text` | ✓ | The converting session's `anonymous_id`, persisted alongside `session_id` at checkout. |
| `shipping_protection_added` | `bool` | — | default: `false` |
| `shipping_protection_amount_cents` | `int4` | ✓ |  |
| `shipping_method_code` | `text` | ✓ |  |
| `shipping_rate_id` | `uuid` | ✓ | → [[shipping_rates]].id |
| `avalara_transaction_code` | `text` | ✓ |  |
| `avalara_total_tax_cents` | `int4` | ✓ |  |
| `avalara_committed_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `advertorial_page_id` → [[advertorial_pages]].`id` (on delete set null)
- `ad_campaign_id` → [[ad_campaigns]].`id` (on delete set null)
- `customer_id` → [[customers]].`id`
- `session_id` → [[storefront_sessions]].`id` (on delete set null)
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

## Indexes

- `orders_workspace_id_created_at_idx (workspace_id, created_at DESC)` — backs workspace order timelines / recent-orders loaders (filter `workspace_id` + sort `created_at DESC` in one index scan, no separate Sort). Diagnosed by the [[../specs/db-index-orders]] DB Health Agent finding; applied to PROD via `CREATE INDEX CONCURRENTLY` (`scripts/apply-orders-workspace-created-at-index.ts`), recorded plain in `20260630120000_orders_workspace_created_at_index.sql` for fresh/local builds.

## Autovacuum tuning

Per-table `reloptions` are tightened on `public.orders` — the cluster default `autovacuum_vacuum_scale_factor = 0.20` is too loose for the fulfillment-status/UTM/address churn on this table, so the DB Health Agent's [[../libraries/db-health|bloat pass]] flagged `dbhealth:bloat:orders`. Fix (owner-approval-only, `20260704120000_orders_autovacuum_scale_factor.sql` + `scripts/apply-orders-autovacuum-migration.ts` — full write-up in [[../recipes/db-vacuum-tune-orders]]):

  - `autovacuum_vacuum_scale_factor = 0.05` (fire at 5% dead, not 20%)
  - `autovacuum_analyze_scale_factor = 0.02` (refresh stats at 2% churn)
  - `autovacuum_vacuum_threshold = 1000` (floor)

**No data is deleted** by the fix — `VACUUM` reclaims dead-tuple space + refreshes planner stats; live rows are untouched.

## Gotchas

- There is no `name` column — use `order_number` (e.g. `"SC129467"`).
- There is no `processed_at` — use `created_at` for time-ordering.
- `shipping_address` and `billing_address` are both JSONB. If only one is populated on the Shopify side, both are mirrored — see feedback_address_mirror_rule.
- `line_items` is JSONB. Variant ids inside, not a join.
- `shopify_order_id` is a numeric string. Internal joins should use `id` (UUID), not the Shopify id.
- `financial_status`: **mixed-case in production data** — both `"PAID"` (94% of rows, from Shopify webhook ingestion) and `"paid"` (6%, normalized) exist. Same for `"REFUNDED"`/`"refunded"`, `"PARTIALLY_REFUNDED"`/`"partially_refunded"`, `"PENDING"`/`"pending"`. Use `ILIKE` or `.in("financial_status", ["PAID","paid"])`. Don't use `.eq("financial_status", "paid")` — you'll miss 94% of rows.
- `fulfillment_status`: `"fulfilled"`, `"partial"`, `"unfulfilled"`, or `null`. Probe before assuming lowercase.
- **`attributed_utm_*` / `landing_site` / `referring_site` are populated by two paths.** Shopify-webhook orders parse them from `landing_site` (`extractOrderUtms` in `shopify-webhooks.ts`). **Native storefront orders** (`source_name='storefront'`, created in `/api/checkout`) had these NULL until 2026-06-14 — they now backfill **first-touch** from the visitor's `storefront_sessions` (earliest session carrying a `utm_source`, by `customer_id` after the identity stitch). So a Meta-sourced storefront sale now shows `attributed_utm_source='meta'` on the order itself, no `storefront_sessions` join needed. Caveat: first-touch only resolves across sessions the visitor was identified in (cross-anonymous_id stitching isn't done) — a pure-anonymous Meta click that converts in a later direct session still attributes `(direct)`.
- **`advertorial_page_id` / `ad_campaign_id` (Phase 2b — Storefront Iteration Engine).** Set in the same `/api/checkout` § 10b backfill: the resolved lander identity is copied from the first-touch session (or the earliest session that landed on an advertorial, if first-touch didn't). Lets `meta_attribution_daily` resolve a variant off a persisted id instead of re-parsing `landing_site`, and survives cross-session conversion. Null for non-lander / pre-2026-06-19 orders; attribution falls back to the URL-parse join for those. See [[../libraries/meta__attribution]] and [[../specs/storefront-iteration-engine]] (Phase 2b).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
