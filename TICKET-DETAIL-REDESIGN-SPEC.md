# Ticket Detail Sidebar Redesign — Spec

## Overview

Split the monolithic customer sidebar on the ticket detail page (`src/app/dashboard/tickets/[id]/page.tsx`) into separate cards. Add subscription actions inline. Make the loyalty redemption a workflow (dropdown + submit) instead of one-click buttons.

## Current State

The ticket detail page is ~2,400 lines with one massive customer card containing: customer info, LTV/orders stats, subscription status, marketing status, subscription list, loyalty points + redemption, recent orders, reviews, store credit, and ban actions.

## Target State

### Separate Cards (each in its own bordered card)

**1. Customer Card**
- Customer name (linked to `/dashboard/customers/{id}`)
- Email, phone
- Shopify link (external, to Shopify admin customer page)
- Retention score badge
- LTV + total orders (compact stats row)
- Marketing status (email/SMS)
- Store credit balance
- Ban/unban action (admin only)

**2. Subscriptions Card**
- List of customer's subscriptions with status badge, items, next billing date
- Each subscription is clickable → links to `/dashboard/subscriptions/{id}`
- **Inline actions per subscription** (admin/agent):
  - Skip Order
  - Order Now (bill now)
  - Pause 30 / Pause 60
  - Change next order date (date picker)
  - Cancel (with reason)
  - Apply coupon (input + apply button)
- Actions shown as a compact dropdown or expandable section per subscription

**3. Orders Card**
- Recent orders (last 5-10)
- Order number, date, amount, fulfillment status
- Link to Shopify order

**4. Loyalty Card**
- Points balance + dollar value
- **Redemption as workflow** (not one-click buttons):
  - "Create redemption" button → opens a dropdown to select tier ($5/$10/$15)
  - "Redeem" submit button after selection
  - Prevents accidental redemptions
- Redemption history (recent)

### Mobile Select Menu

Update the mobile section select to include all 4 cards:
- Conversation
- Ticket Details
- Customer
- Subscriptions
- Orders
- Loyalty
- Reviews
- Actions

Each mobile option shows only its corresponding card. Already partially done (select options added).

### Collapsible Cards
- All sidebar cards start **collapsed** on page load (both desktop and mobile)
- Each card has a header that can be clicked to expand/collapse
- Header shows card title + chevron indicator
- Collapsed state just shows the header row

### Delete Ticket
- Currently a floating red text link at the bottom — looks bad
- Change to a proper opaque danger button: `bg-red-600 text-white rounded-lg px-4 py-2`
- Place at the bottom of the Actions section/card
- Keep the confirmation modal

### Visibility Rules

On desktop: all cards visible in the right sidebar, stacked vertically.
On mobile: only the selected card is visible (controlled by the select menu).

## Implementation Notes

- The existing code has all the data fetching — don't change the data layer
- Just reorganize the JSX render into separate card `<div>` elements
- Each card gets its own visibility class based on `mobileSection`
- Subscription actions call existing API endpoints (already built for the subscriptions detail page)
- Keep the existing state variables — just move them into the right card sections

## File Changes

| File | Change |
|------|--------|
| `src/app/dashboard/tickets/[id]/page.tsx` | Refactor sidebar: split into Customer, Subscriptions, Orders, Loyalty cards. Add inline subscription actions. Loyalty redemption as dropdown workflow. |
