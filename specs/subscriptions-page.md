# Subscriptions Page — Feature Spec

## Overview

A dedicated Subscriptions sidebar section with list + detail views. Agents can see all subscriptions at a glance, filter by status/recovery, and take any action directly — pause, cancel, modify items, apply coupons, change dates. The detail page becomes the canonical place for subscription management and the model that journeys automate.

---

## Sidebar

New top-level sidebar item: **Subscriptions** (between Tickets and Customers)
- Icon: refresh/recurring icon
- Shows count badge of active subscriptions (or at-risk count)

---

## List View (`/dashboard/subscriptions`)

### Columns
| Column | Description |
|--------|-------------|
| Customer | Name + email (linked to customer profile) |
| Products | First 2 item titles, "+X more" if more |
| Status | active / paused / cancelled / expired — color-coded badge |
| Recovery | Badge if in active dunning (amber "In Recovery"), recovered (green "Recovered"), or nothing |
| Next Billing | Date of next billing cycle |
| Payment | Last payment status badge (succeeded / failed / skipped) |
| MRR | Monthly value of this subscription |
| Created | Subscription start date |

### Filters
- **Status**: All, Active, Paused, Cancelled, Expired
- **Recovery**: All, In Recovery, Recovered, Failed (no recovery)
- **Payment**: All, Succeeded, Failed, Skipped
- **Search**: Customer name or email

### Sorting
- Next billing date (default, ascending — upcoming first)
- MRR (high to low)
- Created date
- Status

### Pagination
25 per page

---

## Detail View (`/dashboard/subscriptions/[id]`)

### Header
- Customer name + email (link to customer profile)
- Status badge (large)
- Recovery badge if applicable
- Subscription ID / Shopify contract ID

### Subscription Info Card
- **Products**: Full item list with variant, quantity, SKU, price per item
  - Shipping protection → green badge (not a regular line item)
- **Billing**: Frequency (monthly / every 2 months / etc.), next billing date, last payment status + date
- **Payment method**: Card brand, last 4, expiry
- **Delivery**: Shipping address, shipping method
- **Created**: Start date
- **Subscription age**: X months (with first-renewal flag if < 1 billing cycle)

### Actions Card (right sidebar)
All actions execute via Appstle API and log to customer events.

| Action | UI | Appstle Endpoint |
|--------|-----|------------------|
| **Pause** | Dropdown: 30 days / 60 days / custom | PUT update-status PAUSED |
| **Resume** | Button (only when paused) | PUT update-status ACTIVE |
| **Cancel** | Button + confirmation + reason input | DELETE with cancellationFeedback + cancellationNote |
| **Skip Next Order** | Button + confirmation | PUT skip-upcoming-order |
| **Bill Now** | Button + confirmation | PUT attempt-billing/{id} |
| **Change Next Order Date** | Date picker (tomorrow to 60 days out) | Shopify subscriptionDraftUpdate nextBillingDate |
| **Change Frequency** | Dropdown: Monthly / Every 2 Months | PUT update-billing-interval |
| **Apply Coupon** | Searchable dropdown of available coupons | PUT apply-discount |
| **Remove Coupon** | Button per active discount | PUT remove-discount |

### Item Management Section
Inline editing of subscription line items:

| Action | UI |
|--------|-----|
| **Change quantity** | +/- stepper per item |
| **Remove item** | X button per item with confirmation |
| **Replace item** | Click item → product picker → swap |
| **Add item** | "Add item" button → product search → select variant → add |

Item changes use Appstle's line item mutation endpoints or Shopify's subscription draft workflow (subscriptionContractUpdate → subscriptionDraftLineAdd/Remove/Update → subscriptionDraftCommit).

### Recovery Section (only visible during active dunning)
- Current dunning cycle status (active / skipped / paused / recovered)
- Cards tried (list with last4 + result)
- Next scheduled retry (if payday retry pending)
- Payment update email sent (yes/no + timestamp)
- "Send Payment Update Email" button (manual trigger)
- "Switch Payment Method" dropdown (customer's saved cards)
- Timeline of all payment attempts

### Order History Section
- Recent orders from this subscription
- Each shows: order number, date, total, fulfillment status, items
- Link to full order detail

### Activity Log
- Customer events for this subscription (billing success/failure, status changes, item changes, cancellations, pauses, resumes)
- Chronological, most recent first

---

## Customer Record Integration

On the existing customer detail sidebar (ticket view + customer page):
- Subscriptions section already exists
- Add: recovery badge on subscriptions in active dunning
- Add: amber border + "In Recovery" badge for at-risk subscriptions
- Click subscription → navigates to `/dashboard/subscriptions/[id]`

---

## Ticket View Integration

Same as customer record — subscriptions in the sidebar show recovery status. Agents see at a glance if a customer's subscription is failing payment.

---

## API Endpoints

### New
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/workspaces/[id]/subscriptions` | List with filters, pagination, search |
| GET | `/api/workspaces/[id]/subscriptions/[subId]` | Full detail with items, payment, delivery, orders, dunning |
| PATCH | `/api/workspaces/[id]/subscriptions/[subId]` | Update actions (pause, resume, cancel, skip, frequency, date) |
| POST | `/api/workspaces/[id]/subscriptions/[subId]/items` | Add item |
| PATCH | `/api/workspaces/[id]/subscriptions/[subId]/items/[lineId]` | Update quantity, replace |
| DELETE | `/api/workspaces/[id]/subscriptions/[subId]/items/[lineId]` | Remove item |
| POST | `/api/workspaces/[id]/subscriptions/[subId]/coupon` | Apply coupon |
| DELETE | `/api/workspaces/[id]/subscriptions/[subId]/coupon/[discountId]` | Remove coupon |
| POST | `/api/workspaces/[id]/subscriptions/[subId]/bill-now` | Trigger immediate billing |
| POST | `/api/workspaces/[id]/subscriptions/[subId]/payment-update` | Send payment update email |

### Existing (reuse)
- Appstle endpoints in `src/lib/appstle.ts` (already built)
- Shopify subscription draft workflow for item/date changes

---

## Appstle Endpoints Needed

Most already exist in `src/lib/appstle.ts`. New ones needed:

| Action | Endpoint |
|--------|----------|
| Add line item | Shopify draft workflow: subscriptionDraftLineAdd |
| Remove line item | Shopify draft workflow: subscriptionDraftLineRemove |
| Update line item quantity | Shopify draft workflow: subscriptionDraftLineUpdate |
| Replace line item | Shopify draft workflow: subscriptionDraftLineUpdate (swap variantId) |
| Change next billing date | Shopify subscriptionDraftUpdate with nextBillingDate |
| Get active discounts | GET contract-raw-response (parse discounts.nodes) |

For line item mutations, use Shopify's subscription contract draft workflow:
1. `subscriptionContractUpdate(contractId)` → returns draftId
2. `subscriptionDraftLineAdd/Remove/Update(draftId, ...)` → modify lines
3. `subscriptionDraftCommit(draftId)` → apply changes

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/app/dashboard/subscriptions/page.tsx` | List view with filters |
| `src/app/dashboard/subscriptions/[id]/page.tsx` | Detail view with actions |
| `src/app/api/workspaces/[id]/subscriptions/route.ts` | List API |
| `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts` | Detail + PATCH actions |
| `src/app/api/workspaces/[id]/subscriptions/[subId]/items/route.ts` | Item management |
| `src/app/api/workspaces/[id]/subscriptions/[subId]/coupon/route.ts` | Coupon management |
| `src/app/api/workspaces/[id]/subscriptions/[subId]/bill-now/route.ts` | Trigger billing |
| `src/lib/shopify-subscriptions.ts` | Shopify draft workflow helpers for line items + date changes |

## Files to Modify

| File | Change |
|------|--------|
| `src/components/sidebar.tsx` (or layout) | Add Subscriptions nav item |
| `src/app/dashboard/tickets/[id]/page.tsx` | Recovery badge on subscription cards |
| `src/app/api/customers/[id]/route.ts` | Include dunning status in subscription data |
| `CLAUDE.md` | Update with subscriptions page |

---

## Recovery Badge Logic

A subscription shows recovery status when:
- `dunning_cycles` table has an active/skipped/paused cycle for this `shopify_contract_id`
- Badge text:
  - "In Recovery" (amber) — active dunning cycle, cards being rotated
  - "Payment Failed" (red) — all cards exhausted, waiting for customer
  - "Recovered" (green) — dunning succeeded, shown for 7 days after recovery
  - No badge — subscription is healthy

---

## Display Names for Actions (used by journeys too)

These action labels should be consistent between the subscription detail page and journey flows:
- Pause → "Pause subscription"
- Resume → "Resume subscription"
- Cancel → "Cancel subscription"
- Skip → "Skip next order"
- Frequency → "Change delivery frequency"
- Date → "Change next order date"
- Coupon → "Apply coupon"
- Bill Now → "Process payment now"

This ensures when a journey offers "Pause for 60 days" it maps to the same action an agent would take manually.
