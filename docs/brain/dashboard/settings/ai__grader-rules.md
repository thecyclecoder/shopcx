# Settings · settings/ai/grader-rules

_TODO: page purpose._

**Route:** `/dashboard/settings/ai/grader-rules`

## Features

**Page title:** Grader Rules

**Visible buttons (heuristic — actual labels in source):**
- Edit
- Approve
- Reject
- Disable
- Re-approve
- Cancel
- Save

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/grader-prompts`
- `/api/workspaces/:x/grader-prompts/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/ai/grader-rules/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
