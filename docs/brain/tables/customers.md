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
| `is_internal` | `bool` | — | default: `false`. Team/test account. Any [[storefront_sessions]] that stitches to an internal customer is excluded from the storefront funnel, across all devices. Set on the founder/team customer records. |
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
| `default_address` | `jsonb` | ✓ | Canonical current address written by `update_shipping_address`. The order-creating actions via [[../libraries/customer-shipping-address]] resolve to this first when choosing a shipment destination. |
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
| `phone_status` | `text` | ✓ | Set by [[../inngest/sms-callback-drain]] on fatal Twilio carrier codes (21211/21217/21407/21421/21610/21612/21614/21660/30003-30008). Indicates the phone number is invalid, blocked, or otherwise not reachable (e.g., `'invalid'`, `'failed'`). |
| `phone_status_code` | `int4` | ✓ | The Twilio error code that triggered the phone_status update (e.g., `21612` = unsubscribed number, `30003` = carrier restrictions). |
| `phone_status_at` | `timestamptz` | ✓ | Timestamp when the phone status was last updated (from the failed SMS callback). |
| `preferred_sms_send_hour` | `int2` | ✓ |  |
| `preferred_sms_send_hour_clicks` | `int2` | ✓ |  |
| `preferred_sms_send_hour_at` | `timestamptz` | ✓ |  |
| `short_code` | `varchar` | ✓ |  |
| `braintree_customer_id` | `text` | ✓ |  |
| `comp_role` | `comp_role` enum | ✓ | `employee`｜`influencer`｜`investor`｜`owner`. **null = NOT comp-eligible.** Setting it adds the customer to the **comp allowlist** (owner/admin only) — the gate the comp-subscription renewal fails closed on. |
| `comp_note` | `text` | ✓ | Free-text reason for the comp role ("employee", "creator @x"). |

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
// See [[../README]] linkedIds() — always expand the group before scoping queries.
```

## Autovacuum tuning

Per-table `reloptions` are tightened on `public.customers` — the cluster default `autovacuum_vacuum_scale_factor = 0.20` is too loose for the retention-score / ltv_cents / subscription_status / marketing_status / last_order_at churn on this table (rewrites on every order + every lifecycle transition, on ~620k rows), so the DB Health Agent's [[../libraries/db-health|bloat pass]] flagged `dbhealth:bloat:customers`. Fix (owner-approval-only, `20260819120000_customers_autovacuum_scale_factor.sql` + `scripts/apply-customers-autovacuum-migration.ts` — full write-up in [[../recipes/db-vacuum-tune-customers]]):

  - `autovacuum_vacuum_scale_factor = 0.05` (fire at 5% dead, not 20%)
  - `autovacuum_analyze_scale_factor = 0.02` (refresh stats at 2% churn)
  - `autovacuum_vacuum_threshold = 1000` (floor)

**No data is deleted** by the fix — `VACUUM` reclaims dead-tuple space + refreshes planner stats; live rows are untouched.

## Gotchas

- `email_marketing_status` / `sms_marketing_status`: `"subscribed"`, `"unsubscribed"`, `"not_subscribed"`, or `null`. Lowercase.
- `subscription_status`: `"active"`, `"cancelled"`, `"never"`, `"paused"`. `"never"` = a lead (no orders yet).
- Customers can be linked. To get a customer's full history, expand to linked group first (see `customer_links`).
- A lead IS a customer (no orders, `subscription_status='never'`). No parallel `leads` table.
- **`default_address` is the canonical current address for order destinations.** All order-creating actions ([[../libraries/customer-shipping-address]]) resolve the shipment address to this field first — it is the source-of-truth when a customer updates their address on file via `update_shipping_address`. Subscription `shipping_address` is a fallback for customers who have a subscription but never updated their account address; cited orders are the last resort. This priority prevents stale-order snapshots from silently shipping to the wrong address (ticket 49ddd6c4).

- **`comp_role` IS the comp allowlist.** The set of customers with a non-null `comp_role` is the standing free-product roster. A [[subscriptions]] `comp=true` sub only ships free when its customer has a valid `comp_role` — the renewal path ([[../inngest/internal-subscription-renewals]]) **fails closed** otherwise (no $0 leak). Partial index `idx_customers_comp_role` `(workspace_id, comp_role) WHERE comp_role IS NOT NULL` backs the roster + the Customers → Comp Subscriptions list. See [[../lifecycles/subscription-billing]] § Comp.
- `banned` (storefront ban) vs `portal_banned` (customer portal ban) are different flags.
- Email is the matching key but **`shopify_customer_id` is the primary lookup** — match by it first, fall back to email. See feedback_shopify_id_primary.
- **Email matching uses `ILIKE` (case-insensitive)** across checkout/lead/OTP/identity paths. The `(workspace_id, email)` btree CANNOT serve `ILIKE` → seq scans. A **trigram GIN index `idx_customers_email_trgm`** (`pg_trgm` + `btree_gin`, migration `20260614180000`) backs it (~4ms). If you add a new email-match query, keep it `ILIKE` (or the trigram won't help) — don't reintroduce a plain btree expecting it to serve case-insensitive matches.
- **Account-match branches each ride their own index.** `findUnlinkedMatches` ([[../libraries/account-matching]]) matches duplicates by name, phone, and email as **separate** indexed queries — never a single `.or()`, which forced a full Seq Scan of this 620k-row table and intermittently 500'd PostgREST under concurrent portal-bootstrap load (Control Tower signature `supabase-logs:b5db594131381078`). The supporting indexes: `idx_customers_name_match (workspace_id, first_name, last_name)`, `idx_customers_phone (workspace_id, phone)` partial, and `idx_customers_email_trgm` for the email branch — `idx_customers_name_match` + `idx_customers_phone` added in migration `20260706130000` (`CREATE INDEX CONCURRENTLY`, no lock on the hot table). Add a new match branch → add a matching index and keep it a separate query.
- **Phone-normalized lookup rides its own expression index.** The `find_customers_by_phone` / `find_subscribed_customers_by_phone` RPCs (migration `20260522140000`) compare `right(regexp_replace(phone, '\D', '', 'g'), 10)` against the Twilio inbound's stripped last 10 digits so US formats with/without the `+1` all match — but that expression can't ride `idx_customers_phone` (which indexes raw `phone`), so the marketing-shortcode STOP/START webhook (`/api/webhooks/twilio/marketing-sms`) seq-scanned the 620k-row table and blew the statement timeout (Control Tower signature `vercel:c1b10ab6583b7104`). Partial expression index `idx_customers_phone_last10 (workspace_id, right(regexp_replace(phone, '\D', '', 'g'), 10)) WHERE phone IS NOT NULL AND length(regexp_replace(phone, '\D', '', 'g')) >= 10` (migration `20260818120000`, `CREATE INDEX CONCURRENTLY` via `scripts/apply-customers-phone-last10-index.ts`) is a shape-for-shape match of the RPC predicate → Bitmap Index Scan in single-digit ms. Additive to `idx_customers_phone`, which still backs the exact-string account-matching branch.
- **SMS-subscribed stale-tail count rides its own partial index on `segments_refreshed_at`.** The Control Tower monitor's stale-tail head-count ([[../inngest/control-tower-monitor]]) filters `sms_marketing_status='subscribed'` and asks `.or('segments_refreshed_at.is.null,segments_refreshed_at.lt.<cutoff>')` with `count: 'exact', head: true`. Without a matching index Postgres seq-scanned the ~138K subscribed slice and touched every heap tuple to resolve the OR — under concurrent load it exceeded the statement timeout and PostgREST 500'd once a day (Supabase-logs signature `b9905c8e7f3f9e56`). Partial btree `idx_customers_sms_subscribed_segments_refreshed_at (segments_refreshed_at) WHERE sms_marketing_status = 'subscribed'` (migration `20260927120000`, `CREATE INDEX CONCURRENTLY` via `scripts/apply-customers-sms-segments-refreshed-partial-index.ts`) lets Postgres BitmapOr an `IS NULL` scan with an `< cutoff` range scan → sub-second answer with no heap sweep. Additive to `customers_sms_audience_idx (workspace_id, sms_marketing_status) WHERE phone IS NOT NULL`, which still backs the workspace-scoped campaign audience resolve.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
