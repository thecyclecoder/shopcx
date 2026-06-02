# Settings · settings/text-marketing

Text marketing config: shortlink domain, sender phone, predicted-buyer segment toggle.

**Route:** `/dashboard/settings/text-marketing`

## Features

**Page title:** Text marketing

**Filters:**
- timezone: { value: America/New_York, label: Eastern (New York) },
  { value: America/Chicago, label: Central (Chicago) },
  { value: America/Denver, label: Mountain (Denver) },
  { value: America/Phoenix, label: Arizona (Phoenix, no DST) },
  { value: America/Los_Angeles, label: Pacific (Los Angeles) },
  { value: America/Anchorage, label: Alaska },
  { value: Pacific/Honolulu, label: Hawaii },

**Visible buttons (heuristic — actual labels in source):**
- Cancel
- Change
- Set sender

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/integrations`
- `/api/workspaces/:x/twilio/numbers`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/text-marketing/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
