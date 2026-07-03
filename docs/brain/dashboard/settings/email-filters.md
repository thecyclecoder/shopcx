# Settings · settings/email-filters

Inbound email filters — patterns to ignore (mailer-daemon, no-reply, OOO auto-responders).

**Route:** `/dashboard/settings/email-filters`

## Features

**Page title:** Email Filters

**Visible buttons (heuristic — actual labels in source):**
- Add

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/email-filters`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/email-filters/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
