# Settings · settings/chargebacks

Chargeback automation: auto-cancel toggle, reasons that trigger auto-cancel, notify toggle, evidence reminder days.

**Route:** `/dashboard/settings/chargebacks`

## Features

**Page title:** Chargeback Automation

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/chargebacks/settings`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/chargebacks/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
