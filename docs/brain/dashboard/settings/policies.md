# Settings · settings/policies

5 canonical policies (returns, refunds, exchanges, shipping, etc.) — name + description + public URL + AI talking points.

**Route:** `/dashboard/settings/policies`

## Features

**Page title:** Policies

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[slug]/` → [[settings/policies/[slug]]]

## API endpoints called

- `/api/workspaces/:x/policies`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/policies/page.tsx` — the page itself
- `src/app/dashboard/settings/policies/[slug]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
