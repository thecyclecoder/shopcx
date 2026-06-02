# Dashboard · delivery/email

_TODO: page purpose._

**Route:** `/dashboard/delivery/email`

## Features

**Page title:** Email Delivery

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/delivery-stats`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/delivery/email/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
