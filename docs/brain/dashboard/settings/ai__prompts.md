# Settings · settings/ai/prompts

_TODO: page purpose._

**Route:** `/dashboard/settings/ai/prompts`

## Features

**Page title:** AI Agent Prompts

**Visible buttons (heuristic — actual labels in source):**
- Add Prompt
- Save
- Cancel
- Approve
- Reject
- Edit
- Re-approve
- Delete

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/sonnet-prompts`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/ai/prompts/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
