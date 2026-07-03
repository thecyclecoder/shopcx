# Settings · settings/sandbox

Sandbox mode toggle. When on, AI drafts become internal notes; agents click 'Approve & Send' to deliver.

**Route:** `/dashboard/settings/sandbox`

## Features

**Page title:** Sandbox Mode

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/sandbox/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
