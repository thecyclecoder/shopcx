# Returns Dashboard Page — Build Spec

## Overview

New page at `/dashboard/returns` — sidebar item below Subscriptions. Shows all returns across the workspace with status tracking, resolution details, financials, and quick actions.

## Sidebar

Add to `src/app/dashboard/sidebar.tsx` after Subscriptions:

```typescript
{ href: "/dashboard/returns", label: "Returns", icon: "M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" }
// ↑ arrow-uturn-left icon
```

## List Page: `/dashboard/returns/page.tsx`

### Layout

Same pattern as Subscriptions list page (`src/app/dashboard/subscriptions/page.tsx`):
- Header with title + count
- Filter bar
- Sortable table
- Pagination (25 per page)

### Filters

| Filter | Type | Options |
|--------|------|---------|
| Status | Multi-select pills | Pending, Open, Label Created, In Transit, Delivered, Processing, Restocked, Refunded, Closed, Cancelled |
| Resolution | Dropdown | Store Credit (return), Refund (return), Store Credit (no return), Refund (no return) |
| Source | Dropdown | All, Playbook, Agent, Portal, Shopify |
| Search | Text input | Search by order number, customer name, email, tracking number |
| Date range | Preset pills | Today, 7d, 30d, 90d, All |

### Table Columns

| Column | Sortable | Content |
|--------|----------|---------|
| Order # | Yes | Order number, clickable → order detail. Shows order date below. |
| Customer | Yes | Name + email. Clickable → customer detail. |
| Status | Yes | Color-coded badge (see status badges below) |
| Resolution | - | "Store Credit" or "Refund" with "(return)" or "(no return)" suffix |
| Amount | Yes | Net refund amount. Shows breakdown on hover: "$67.61 ($74.81 - $7.20 label)" |
| Tracking | - | Tracking number (truncated), carrier badge, clickable → carrier tracking page. Shows "--" if no tracking yet. |
| Source | - | Small badge: "Playbook", "Agent", "Portal", "Shopify" |
| Created | Yes | Relative date ("2 days ago"), absolute on hover |

### Status Badges

| Status | Color | Label |
|--------|-------|-------|
| pending | zinc/gray | Pending |
| open | blue | Open |
| label_created | indigo | Label Sent |
| in_transit | amber | In Transit |
| delivered | cyan | Delivered |
| processing | violet | Processing |
| restocked | emerald | Restocked |
| refunded | green | Refunded |
| closed | zinc | Closed |
| cancelled | red | Cancelled |

### Empty State

"No returns yet. Returns are created automatically by playbooks or manually by agents."

## Detail Page: `/dashboard/returns/[id]/page.tsx`

### Layout

Two-column layout (same pattern as ticket detail or subscription detail):
- Left: return timeline + actions
- Right: order info + customer sidebar

### Left Column

#### Header
- Order number + status badge
- Resolution type
- Source badge
- Created date

#### Financial Summary Card
```
Order Total:    $74.81
Label Cost:    -$7.20
─────────────────────
Net Refund:     $67.61   [Store Credit / Refund to Visa ****1234]
```

#### Return Items Card
List of line items being returned:
- Product image thumbnail
- Title + variant
- Quantity
- Line item price

#### Timeline Card
Chronological list of events:
```
Apr 4, 2:30 PM  Return created (source: AI Playbook — Unwanted Charge)
Apr 4, 2:31 PM  Return label generated (USPS Ground, $7.20)
Apr 4, 2:31 PM  Label emailed to customer
Apr 5, 10:00 AM Picked up by carrier (tracking: 9400...)
Apr 7, 3:15 PM  In transit — departed Memphis, TN
Apr 9, 11:30 AM Delivered to warehouse
Apr 9, 4:00 PM  Items restocked (1x Amazing Coffee)
Apr 9, 4:01 PM  Store credit of $67.61 issued
Apr 9, 4:01 PM  Return closed
```

Each event shows: timestamp, description, optional details expandable.

Timeline data comes from:
- `returns` table timestamps (created_at, shipped_at, delivered_at, processed_at, refunded_at)
- `customer_events` table (filtered by return-related event types)
- Future: EasyPost tracking events

#### Actions Card
Available actions based on status:

| Status | Actions |
|--------|---------|
| open | "Generate Label" (future EasyPost), "Add Tracking Manually", "Cancel Return" |
| label_created | "Resend Label Email", "Cancel Return" |
| in_transit | (no actions — waiting for delivery) |
| delivered | "Mark as Restocked", "Mark as Missing" |
| processing | "Mark as Restocked", "Mark as Missing" |
| restocked | "Issue Refund", "Issue Store Credit" |
| refunded | "Close Return" |
| closed | (no actions) |
| cancelled | (no actions) |

**"Add Tracking Manually"** — Modal with tracking number + carrier dropdown (USPS, UPS, FedEx, DHL, Other).

**"Mark as Restocked"** — Calls `disposeReturnItems` with RESTOCKED. Requires selecting inventory location (dropdown of workspace Shopify locations).

**"Issue Refund"** — Calls Shopify refund API or store credit system. Shows confirmation with amount.

### Right Column

#### Order Info Card
- Order number, date, total
- Fulfillment status
- Line items summary
- Link to full order detail

#### Customer Sidebar Card
Same customer sidebar as ticket detail:
- Name, email, phone
- LTV, retention score, total orders
- Subscription status
- Link to customer detail

#### Ticket Card (if linked)
- Ticket subject/preview
- Status badge
- Link to ticket detail
- Shows playbook summary if available

## API Endpoints

### `GET /api/workspaces/[id]/returns`

Query params:
- `status` — comma-separated filter
- `resolution` — single value
- `source` — single value
- `search` — text search (order number, customer name/email, tracking)
- `sort` — column name (default: `created_at`)
- `order` — `asc` or `desc` (default: `desc`)
- `limit` — page size (default: 25, max: 100)
- `offset` — pagination offset

Response:
```json
{
  "returns": [
    {
      "id": "uuid",
      "order_number": "SC126222",
      "customer": { "id": "uuid", "first_name": "Elvira", "last_name": "Lamping", "email": "elviexpress@aol.com" },
      "status": "in_transit",
      "resolution_type": "refund_return",
      "order_total_cents": 7481,
      "label_cost_cents": 720,
      "net_refund_cents": 6761,
      "tracking_number": "9400111899223456789012",
      "carrier": "USPS",
      "source": "playbook",
      "created_at": "2026-04-04T14:30:00Z"
    }
  ],
  "total": 42
}
```

Implementation: join `returns` with `customers` for name/email. Filter by workspace_id.

### `GET /api/workspaces/[id]/returns/[returnId]`

Full return detail including:
- All return fields
- Customer data (joined)
- Order data (joined)
- Ticket data if linked (joined)
- Return line items (from JSONB)
- Timeline events (from customer_events + return timestamps)

### `PATCH /api/workspaces/[id]/returns/[returnId]`

Update tracking, status, notes. Used by "Add Tracking Manually" action.

### `POST /api/workspaces/[id]/returns/[returnId]/dispose`

Agent action to mark items received.
```json
{ "disposition": "RESTOCKED", "location_id": "gid://shopify/Location/123" }
```

### `POST /api/workspaces/[id]/returns/[returnId]/refund`

Agent action to issue refund/credit.
```json
{ "type": "store_credit" | "refund" }
```

## Customer Events

Log these events to `customer_events` for timeline:

| event_type | source | When |
|------------|--------|------|
| `return.created` | playbook/agent/portal | Return initiated |
| `return.label_generated` | system | EasyPost label created |
| `return.label_emailed` | system | Label sent to customer |
| `return.shipped` | system | Tracking shows picked up |
| `return.in_transit` | system | Tracking update |
| `return.delivered` | system | Tracking shows delivered |
| `return.restocked` | system/agent | Items disposed as restocked |
| `return.refunded` | system/agent | Refund/credit issued |
| `return.closed` | system | Return completed |
| `return.cancelled` | agent | Return cancelled |

## Settings

### Settings > Integrations > Returns card

New card in the Integrations section:

- **Return address** — form with name, street1, street2, city, state, zip, country, phone
- **EasyPost API key** — encrypted field (same pattern as Shopify/Appstle keys)
- **Default parcel dimensions** — length, width, height (inches), weight (oz)
- **Preferred carrier** — dropdown: USPS (default), UPS, FedEx
- **Test connection** — button that calls EasyPost to verify API key
- **Return label enabled** — toggle. If off, returns are created without labels (manual tracking)

## Files to Create

| File | Purpose |
|------|---------|
| `src/app/dashboard/returns/page.tsx` | List page with filters, table, pagination |
| `src/app/dashboard/returns/[id]/page.tsx` | Detail page with timeline, actions, sidebar |
| `src/app/api/workspaces/[id]/returns/route.ts` | List + create API |
| `src/app/api/workspaces/[id]/returns/[returnId]/route.ts` | Detail + update API |
| `src/app/api/workspaces/[id]/returns/[returnId]/dispose/route.ts` | Dispose action |
| `src/app/api/workspaces/[id]/returns/[returnId]/refund/route.ts` | Refund/credit action |

## UI Component Patterns

Follow existing patterns from:
- **List page**: `src/app/dashboard/subscriptions/page.tsx` — table, filters, pagination, search
- **Detail page**: `src/app/dashboard/subscriptions/[id]/page.tsx` — two-column, cards, actions, timeline
- **Status badges**: Same color/size pattern as subscription status badges
- **Customer sidebar**: Reuse the same customer sidebar component from ticket detail

## Order of Implementation

1. API: List + create + detail routes (read from `returns` table)
2. List page: table with filters, sorting, pagination
3. Detail page: timeline, financial summary, return items, actions
4. Action handlers: dispose, refund, add tracking, cancel
5. Sidebar nav: add Returns item
6. Settings card: return address + EasyPost config (can be empty initially)
