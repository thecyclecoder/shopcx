# Dashboard · marketing/text/new

SMS campaign builder. Audience selector, message body with {coupon} + {shortlink}, MMS image upload, send_date + target_local_hour.

**Route:** `/dashboard/marketing/text/new`

## Features

**Page title:** New text campaign

**Filters:**
- timezone: { value: America/New_York, label: Eastern (New York) },
  { value: America/Chicago, label: Central (Chicago) },
  { value: America/Denver, label: Mountain (Denver) },
  { value: America/Phoenix, label: Arizona (Phoenix, no DST) },
  { value: America/Los_Angeles, label: Pacific (Los Angeles) },
  { value: America/Anchorage, label: Alaska },
  { value: Pacific/Honolulu, label: Hawaii },

**Visible buttons (heuristic — actual labels in source):**
- Save draft

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`
- `/api/workspaces/:x/sms-campaigns`
- `/api/workspaces/:x/sms-campaigns/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/text/new/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
