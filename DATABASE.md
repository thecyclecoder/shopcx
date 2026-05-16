# Database query reference

Patterns, gotchas, and idiomatic queries for the Supabase tables. Read this before writing one-off scripts that touch the DB — saves the "why did my query return nothing" debug loop.

## Status & enum values — always check the actual stored case

Postgres comparisons are case-sensitive. Many tables store **lowercase** enum-style values but it's easy to assume uppercase from JS conventions. Always probe an unfiltered sample first, or check `pg_enum` if it's a real enum type.

| Table | Column | Actual values |
|---|---|---|
| `subscriptions` | `status` | `"active"`, `"paused"`, `"cancelled"` (lowercase!) |
| `customers` | `email_marketing_status` | `"subscribed"`, `"unsubscribed"`, `"not_subscribed"`, `null` |
| `customers` | `sms_marketing_status` | same |
| `customers` | `subscription_status` | `"active"`, `"cancelled"`, `"never"`, `"paused"` |
| `tickets` | `status` | `"open"`, `"pending"`, `"closed"`, `"archived"` |
| `tickets` | `channel` | `"email"`, `"chat"`, `"help_center"`, `"social_comments"`, `"meta_dm"`, `"sms"` |
| `returns` | `status` | `"open"`, `"label_created"`, `"in_transit"`, `"delivered"`, `"refunded"`, `"restocked"`, `"cancelled"` |
| `returns` | `resolution_type` | `"refund_return"`, `"store_credit_return"`, `"refund_no_return"`, `"store_credit_no_return"` |
| `returns` | `source` | `"ai"`, `"agent"`, `"playbook"`, `"portal"`, `"system"` |
| `orders` | `financial_status` | `"paid"`, `"refunded"`, `"partially_refunded"`, `"voided"` |
| `orders` | `fulfillment_status` | `"fulfilled"`, `"partial"`, `"unfulfilled"` (or `null`) |

If you write `.eq("status", "ACTIVE")` you'll get back zero rows even though there are thousands of active subscriptions.

## Customer linkage — three ways to find a customer's data

Customers can be linked together (multiple emails / phones for the same real person). When pulling per-customer history (orders, subs, tickets, returns, events), always include linked accounts.

```ts
// Get the group of linked customer ids for a given customer
async function linkedIds(admin, customerId): Promise<string[]> {
  const { data: link } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links")
    .select("customer_id").eq("group_id", link.group_id);
  return (group || []).map((r) => r.customer_id);
}
// Then: .in("customer_id", ids)
```

**Fallback for subscriptions specifically:** subscriptions also have `shopify_customer_id` as a denormalized column. When a sub's `customer_id` UUID is wrong/missing in our table, querying by `shopify_customer_id` against `customers.shopify_customer_id` is a safe second pass.

```ts
const { data: subs } = await admin.from("subscriptions")
  .select("...")
  .or(`customer_id.eq.${cid},shopify_customer_id.eq.${shopifyCustomerId}`);
```

## Column names that are easy to get wrong

| Table | Wrong | Right |
|---|---|---|
| `orders` | `name` | `order_number` (e.g. `"SC129467"`) |
| `orders` | `processed_at` | `created_at` |
| `orders` | `subtotal_price_cents` | (not stored — use `total_cents` and back out tax/shipping if needed) |
| `ticket_messages` | `workspace_id` | (doesn't exist — keyed by `ticket_id`; workspace comes via `tickets`) |
| `ticket_messages` | `clean_body` / `cleaned_body` | `body_clean` |
| `ticket_messages` | `resend_id` | `resend_email_id` — and **always check `error` on the insert**, supabase-js does not throw on unknown-column errors |
| `returns` | `name` | `order_number` |
| `customer_events` | `event_name` | `event_type` |
| `customer_events` | `event_data` | `properties` (JSONB) |
| `subscriptions` | `cancelled_at` / `paused_at` | (not stored as columns — use `status` lowercase; the timestamp lives in `customer_events` if you need when) |

## ID shapes — three IDs per order, two per customer, etc.

| Entity | Internal UUID | Shopify-side | Human-readable |
|---|---|---|---|
| Order | `orders.id` (UUID) | `orders.shopify_order_id` (numeric string) | `orders.order_number` ("SC128954") |
| Customer | `customers.id` (UUID) | `customers.shopify_customer_id` (numeric string) | `customers.email` |
| Subscription | `subscriptions.id` (UUID) | `subscriptions.shopify_contract_id` (numeric string) | — |
| Return | `returns.id` (UUID) | `returns.shopify_return_gid` (`gid://shopify/Return/N`) | `returns.order_number` |
| Product | `products.id` (UUID) | `products.shopify_product_id` (numeric string) | `products.title` |
| Variant | `product_variants.id` (UUID) | `product_variants.shopify_variant_id` (numeric string) | `product_variants.title` |

**Rule of thumb (from feedback memory):** when joining between our internal tables, ALWAYS use the UUID. Use Shopify IDs only when crossing the Shopify boundary (calling their API, parsing webhooks). The internal-relations rule is hard — see `feedback_no_shopify_id_for_relationships`.

## Common query recipes

### Customer's full order history (across linked accounts)

```ts
const ids = await linkedIds(admin, customerId);
const { data: orders } = await admin.from("orders")
  .select("order_number, created_at, total_cents, line_items, financial_status")
  .in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Customer's truly-active subscriptions

```ts
const ids = await linkedIds(admin, customerId);
const { data: subs } = await admin.from("subscriptions")
  .select("shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, total_price_cents, cancelled_at, paused_at")
  .in("customer_id", ids)
  .eq("status", "active");   // lowercase!
```

To distinguish currently-active from currently-paused: `status === "active"` is paying; `status === "paused"` is not auto-charging until resumed.

### Active subscriptions at a point in time

```ts
const { data: subs } = await admin.from("subscriptions")
  .select("status, created_at, cancelled_at, paused_at")
  .in("customer_id", ids);
const activeAt = (asOf: Date) => (subs || []).filter((s) =>
  s.status === "active" &&
  s.created_at && new Date(s.created_at) < asOf &&
  (!s.cancelled_at || new Date(s.cancelled_at) > asOf) &&
  (!s.paused_at || new Date(s.paused_at) > asOf)
);
```

### Customer's open + non-cancelled returns

```ts
const { data: returns } = await admin.from("returns")
  .select("order_number, status, label_url, tracking_number, net_refund_cents, delivered_at, refunded_at")
  .in("customer_id", ids)
  .neq("status", "cancelled")
  .order("created_at", { ascending: false });
```

### Returns "our system created" vs imported

```ts
.not("easypost_shipment_id", "is", null)   // ours
.is("easypost_shipment_id", null)          // imported/external (don't touch refunds)
```

### Ticket conversation transcript (clean version, chronological)

```ts
const { data: msgs } = await admin.from("ticket_messages")
  .select("direction, visibility, author_type, body, body_clean, created_at")
  .eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
// Use body_clean for AI prompts (strips HTML + email reply chains).
// Use body for verbatim display.
```

## Service-role vs anon client

- **`createAdminClient()`** — service role, bypasses RLS, used for all server-side writes and most reads
- **`createClient()` (in `src/lib/supabase/server.ts`)** — anon client, respects RLS, used for SSR pages that must be scoped to the logged-in user

All scripts and Inngest functions should use `createAdminClient()`. RLS errors silently return empty data, which is a debugging nightmare in scripts.

## .env loader pattern for scripts

Scripts in `scripts/` don't auto-load `.env.local` like Next.js does. Use:

```ts
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
```

Or shorter: `--env-file=.env.local` flag on `npx tsx`, but the loader above is more portable.

## Probing technique — confirm before assuming

When in doubt: read one row + `Object.keys()` to verify column names, or `.select("status").limit(2000)` and bucket by value to confirm enum shapes. Five seconds of probing saves an hour of "why is my filter empty" debugging.

```ts
// Quick column probe
const { data } = await admin.from("returns").select("*").limit(1);
console.log(Object.keys(data?.[0] || {}));

// Quick enum probe
const { data: sample } = await admin.from("subscriptions").select("status").limit(2000);
const counts = new Map();
for (const r of sample || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
console.log([...counts.entries()]);
```

## Counts of rows vs counts in a filter

The supabase-js client has two paths for counts:

```ts
// Just count, no rows fetched (head: true) — fast, no row payload
const { count } = await admin.from("returns")
  .select("id", { count: "exact", head: true })
  .eq("status", "delivered");

// Fetch rows AND count — `count` populates alongside data
const { data, count } = await admin.from("returns")
  .select("*", { count: "exact" })
  .eq("status", "delivered");
```

Don't `.select("*")` + `.length` for counts — that fetches every row first.

## Adding new patterns

When you discover a gotcha during a debug session, add it here. The longer this file gets, the less time the next agent wastes.
