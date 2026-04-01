# Orders Page + Amplifier Sync

## Overview

A new **Orders** sidebar page providing operational visibility into order fulfillment status, Amplifier 3PL sync health, and SLA monitoring. Powered by Amplifier webhooks (`order.received`, `order.shipped`) that keep our `orders` table enriched with Amplifier data in real-time.

---

## Part 1: Amplifier Webhook Sync

### Webhook Subscriptions

Register two webhooks with Amplifier via `POST /webhooks`:

| Event | URL | Purpose |
|---|---|---|
| `order.received` | `https://shopcx.ai/api/webhooks/amplifier` | Store Amplifier UUID on our order |
| `order.shipped` | `https://shopcx.ai/api/webhooks/amplifier` | Store tracking info from Amplifier |

Registration should happen from the Amplifier integration settings page (button: "Register Webhooks"), similar to Shopify webhook registration.

### Webhook Handler: `POST /api/webhooks/amplifier`

Single endpoint, routes by `type` field in payload.

**`order.received`:**
- Payload: `{ data: { id, reference_id, order_source } }`
- `reference_id` = Shopify order number without prefix (e.g., `126823`)
- Match `reference_id` to `orders.order_number` by stripping the workspace's order prefix (e.g., `SC`)
- Store `data.id` as `amplifier_order_id` on the order
- Store `timestamp` as `amplifier_received_at`

**`order.shipped`:**
- Payload: `{ data: { id, reference_id, method, tracking_number, date, items } }`
- Match by `amplifier_order_id` or fall back to `reference_id` → `order_number`
- Store tracking number, carrier/method, and ship date
- Update `amplifier_shipped_at` timestamp

### Auth / Verification

Amplifier doesn't document webhook signatures. Verify by checking that the `reference_id` maps to a real order in our system. Consider also validating the source IP or using a secret query param in the webhook URL (e.g., `?secret=<workspace_amplifier_webhook_secret>`).

### Database Changes

Add columns to `orders` table:

```sql
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS amplifier_order_id UUID,
  ADD COLUMN IF NOT EXISTS amplifier_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amplifier_shipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amplifier_tracking_number TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_carrier TEXT;
```

Add columns to `workspaces` table for SLA settings:

```sql
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS amplifier_tracking_sla_days INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS amplifier_cutoff_hour INTEGER DEFAULT 11,
  ADD COLUMN IF NOT EXISTS amplifier_cutoff_timezone TEXT DEFAULT 'America/Chicago',
  ADD COLUMN IF NOT EXISTS amplifier_shipping_days INTEGER[] DEFAULT '{1,2,3,4,5}';
```

`amplifier_shipping_days`: array of ISO day-of-week (1=Monday ... 7=Sunday). Default Mon-Fri.

---

## Part 2: Amplifier Integration Settings

Add to the existing Amplifier card on Settings > Integrations:

### SLA Settings

- **Expected tracking days**: number input (default: 1) — "Orders should receive tracking within X business days of receipt"
- **Receive cutoff time**: hour picker (default: 11:00 AM) + timezone dropdown (default: Central) — "Orders received before this time count as received that business day"
- **Shipping days**: day-of-week checkboxes (default: Mon-Fri) — "Days your 3PL ships orders"

### Webhook Registration

- **Register Webhooks** button — calls Amplifier `POST /webhooks` for `order.received` and `order.shipped`
- Shows status of registered webhooks (via `GET /webhooks` on load)
- **Remove Webhooks** button if already registered

---

## Part 3: Orders Page

### Sidebar Navigation

Add **Orders** to the sidebar between Tickets and Subscriptions (or between Subscriptions and Customers — match the data flow: Tickets > Orders > Subscriptions > Customers).

### List View: `/dashboard/orders`

Sortable table with columns:

| Column | Source |
|---|---|
| Order | `order_number` (clickable, links to Shopify admin) |
| Customer | customer name/email (from `customers` join) |
| Date | `created_at` |
| Items | line item count or first SKU |
| Total | `total_cents` formatted |
| Status | fulfillment status badge |
| Amplifier | sync status indicator + Amplifier status (see below) |
| Tracking | tracking number (linked) or "—" |
| Actions | Links (see below) |

### Amplifier Status

When an order has an `amplifier_order_id`, show the Amplifier status from the `order.received` / `order.shipped` data. Amplifier statuses: `Awaiting Inventory`, `Processing Shipment`, `In Fulfillment`, `Shipped`, `Pending Cancellation`, `Cancelled`.

Orders in `Awaiting Inventory` or `Processing Shipment` are still editable on Amplifier's side — show a subtle indicator (e.g., "Editable" label) so agents know changes can still be made via the Amplifier dashboard.

### Actions Column

- **View in Amplifier**: External link icon, opens `https://my.amplifier.com/orders/{amplifier_order_id}` in new tab. Only shown when `amplifier_order_id` exists.
- **View in Shopify**: External link icon, opens Shopify admin order page in new tab.

**Important note for agents:** Once an order is handed off from Shopify to Amplifier, changes made in Shopify (address, items, etc.) do NOT propagate to Amplifier. Changes must be made directly in the Amplifier dashboard. Display this as a persistent info banner or tooltip on the page.

### Filters

Filter bar at the top with preset filters. Active filter is highlighted. Counts shown per filter.

| Filter | Label | Logic |
|---|---|---|
| all | All Orders | No filter |
| sync_error | Sync Errors | `amplifier_order_id IS NULL AND fulfillment_status != 'fulfilled' AND created_at < NOW() - INTERVAL '6 hours' AND NOT ('suspicious' = ANY(tags))` |
| suspicious | Suspicious | `'suspicious' = ANY(tags)` |
| awaiting_tracking | Awaiting Tracking | `amplifier_order_id IS NOT NULL AND amplifier_shipped_at IS NULL AND within SLA window` |
| late_tracking | Late Tracking | `amplifier_order_id IS NOT NULL AND amplifier_shipped_at IS NULL AND past SLA window` |
| in_transit | In Transit | `amplifier_shipped_at IS NOT NULL AND fulfillment_status != 'fulfilled'` |
| fulfilled | Fulfilled | `fulfillment_status = 'fulfilled'` |

### SLA Calculation

To determine if an order is "awaiting tracking" vs "late tracking":

1. Take `amplifier_received_at` timestamp
2. Convert to the workspace's configured cutoff timezone
3. If received before cutoff hour, receipt business day = that day. Otherwise, receipt business day = next shipping day.
4. Count forward `amplifier_tracking_sla_days` shipping days from the receipt business day
5. If current time > end of the SLA deadline day → **late tracking**
6. Otherwise → **awaiting tracking**

### Summary Cards

Row of cards at the top of the page showing counts for each filter category. Clicking a card activates that filter. Cards:

| Card | Color | Count Query |
|---|---|---|
| Sync Errors | Red | Orders missing Amplifier ID, unfulfilled, >6hrs, not suspicious |
| Suspicious | Amber | Orders tagged suspicious |
| Late Tracking | Red | Past SLA, no tracking |
| Awaiting Tracking | Gray | Within SLA, no tracking |
| In Transit | Blue | Has tracking, not fulfilled |
| Fulfilled | Green | Fulfilled |

Cards act as both summary stats and filter buttons — active card is visually highlighted.

### Default View

Page loads with **Late Tracking** filter active by default (card highlighted).

### Pagination

25 orders per page with page controls. Default sort: newest first.

### Search

Search by order number (e.g., "SC126823"), customer name, or customer email. Search executes on **Enter key press only** (not on type).

### Status Badges

- **Sync Error** — red badge
- **Suspicious** — amber badge (matches fraud detection styling)
- **Awaiting Tracking** — gray/neutral badge
- **Late Tracking** — red badge
- **In Transit** — blue badge
- **Fulfilled** — green badge

---

## Part 4: Webhook Auth Strategy

Since Amplifier doesn't provide webhook signatures, use a secret token in the webhook URL:

- Generate a random token per workspace when registering webhooks
- Store as `amplifier_webhook_token` (encrypted) in workspaces table
- Register webhook URL as: `https://shopcx.ai/api/webhooks/amplifier?token=<token>`
- Validate token on every incoming request

---

## Key Files to Create/Modify

| File | Action |
|---|---|
| `supabase/migrations/YYYYMMDD_orders_amplifier_sync.sql` | New columns on orders + workspaces |
| `src/app/api/webhooks/amplifier/route.ts` | New — webhook handler |
| `src/app/dashboard/orders/page.tsx` | New — orders list page |
| `src/app/api/workspaces/[id]/orders/route.ts` | New — orders API with filters |
| `src/app/dashboard/settings/integrations/page.tsx` | Modify — add SLA settings + webhook registration |
| `src/app/api/workspaces/[id]/integrations/amplifier/webhooks/route.ts` | New — register/list/delete Amplifier webhooks |
| `src/app/dashboard/sidebar.tsx` (or equivalent) | Modify — add Orders nav item |

---

## Out of Scope

- Backfill of historical Amplifier IDs
- Notifications/alerts for sync errors (can add later)
- Direct Amplifier order mutations (cancel, address change) — API doesn't document these endpoints yet. For now, link out to Amplifier dashboard.
- Shopify order refund/cancel from this page (can add later)
