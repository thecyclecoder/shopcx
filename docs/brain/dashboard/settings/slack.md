# Settings · settings/slack

Slack workspace connect + notification routing rules (which events go to which channel).

**Route:** `/dashboard/settings/slack`

## Features

**Page title:** Slack Notifications

**Visible buttons (heuristic — actual labels in source):**
- None

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/slack/channels`
- `/api/workspaces/:x/slack-rules`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/slack/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
