# Settings · settings/playbooks

Playbook CRUD: steps, policies, exceptions, disqualifiers, stand-firm tunables. Per-playbook simulator.

**Route:** `/dashboard/settings/playbooks`

## Features

**Page title:** Playbooks

**Filters:**
- data_access: recent_orders, subscriptions, customer_events, fulfillments, payment_methods,

**Visible buttons (heuristic — actual labels in source):**
- Add Playbook
- Simulate
- Edit
- Delete
- Add Step
- Save Step
- Cancel
- Add Policy
- Save Policy
- Save Exception

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/customers`
- `/api/workspaces/:x/playbooks`
- `/api/workspaces/:x/playbooks/fix`
- `/api/workspaces/:x/playbooks/simulate`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/playbooks/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
