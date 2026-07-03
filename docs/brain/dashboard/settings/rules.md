# Settings · settings/rules

Compound AND/OR rules engine. 8 action types: add/remove tags, set status, assign, auto-reply, internal note, customer update, Appstle action.

**Route:** `/dashboard/settings/rules`

## Features

**Page title:** Rules

**Filters:**
- trigger: { value: ticket.created, label: Ticket Created },
  { value: ticket.message_received, label: Customer Reply },
  { value: ticket.message_sent, label: Agent Reply },
  { value: ticket.status_changed, label: Ticket Status Changed },
  { value: order.created, label: Order Created },
  { value: customer.updated, label: Customer Updated },
  { value: subscription.created, label: Subscription Created },
  { value: subscription.paused, label: Subscription Paused },
  { value: subscription.cancelled, label: Subscription Cancelled },
  { value: subscription.billing-failure, label: Billing Failed },
  { value: subscription.billing-skipped, label: Billing Skipped },
  { value: subscription.billing-success, label: Billing Succeeded },
- field: { value: ticket.subject, label: Ticket Subject, type: text },
  { value: ticket.status, label: Ticket Status, type: select, options: [open, pending, closed
- op: { value: equals, label: equals },
  { value: not_equals, label: does not equal },
  { value: contains, label: contains },
  { value: not_contains, label: does not contain },
  { value: starts_with, label: starts with },
  { value: greater_than, label: greater than },
  { value: less_than, label: less than },
  { value: greater_or_equal, label: >= },
  { value: less_or_equal, label: <= },
  { value: is_empty, label: is empty },
  { value: is_not_empty, label: is not empty },
  { value: array_contains, label: array contains },
- action: { value: add_tag, label: Add Tag },
  { value: remove_tag, label: Remove Tag },
  { value: set_status, label: Set Ticket Status },
  { value: assign, label: Assign Ticket },
  { value: auto_reply, label: Send Auto-Reply },
  { value: internal_note, label: Add Internal Note },
  { value: update_customer, label: Update Customer Field },
  { value: appstle_action, label: Subscription Action (Appstle) },

**Visible buttons (heuristic — actual labels in source):**
- New Rule
- Edit
- Delete
- Cancel

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/members`
- `/api/workspaces/:x/rules`
- `/api/workspaces/:x/rules/:x`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/rules/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
