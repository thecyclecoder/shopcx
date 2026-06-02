# Settings · settings/order-sources

Shopify order source name → internal mapping (e.g. 'app:Amazon' → 'amazon').

**Route:** `/dashboard/settings/order-sources`

## Features

**Page title:** Shopify Settings

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/order-sources`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/order-sources/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
