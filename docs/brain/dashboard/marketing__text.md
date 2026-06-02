# Dashboard · marketing/text

SMS campaign builder + campaign list. iPhone-style phone preview. Phone-number validation. Coupon attachment. Per-recipient local-time send.

**Route:** `/dashboard/marketing/text`

## Features

**Page title:** Text marketing

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[marketing/text/[id]]]
- `new/` → [[marketing/text/new]]

## API endpoints called

- `/api/workspaces/:x/klaviyo-sms-history`
- `/api/workspaces/:x/klaviyo-sms-import`
- `/api/workspaces/:x/sms-campaigns`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/text/page.tsx` — the page itself
- `src/app/dashboard/marketing/text/[id]/page.tsx` — sub-route
- `src/app/dashboard/marketing/text/new/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
