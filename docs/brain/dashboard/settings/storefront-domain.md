# Settings · settings/storefront-domain

Custom domain + subdomain configuration for the storefront.

**Route:** `/dashboard/settings/storefront-domain`

## Features

**Page title:** Storefront Domain

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/storefront-domain/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
