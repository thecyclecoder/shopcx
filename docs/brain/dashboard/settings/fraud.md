# Settings · settings/fraud

Fraud rule configuration. Per-rule: active toggle, thresholds, disqualifiers.

**Route:** `/dashboard/settings/fraud`

## Features

**Page title:** Fraud Detection Rules

**Filters:**
- severity: { value: low, label: Low },
  { value: medium, label: Medium },
  { value: high, label: High },

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/fraud-rules`
- `/api/workspaces/:x/fraud-rules/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/fraud/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
