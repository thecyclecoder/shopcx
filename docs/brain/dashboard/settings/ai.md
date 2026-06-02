# Settings · settings/ai

AI configuration: personality, channel config (turn limit / confidence / auto-resolve), sonnet prompts editor.

**Route:** `/dashboard/settings/ai`

## Features

**Page title:** AI Agent

**Visible buttons (heuristic — actual labels in source):**
- Add Personality
- Cancel
- Edit
- Delete
- Add AI Workflow

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `grader-rules/` → [[settings/ai/grader-rules]]
- `prompts/` → [[settings/ai/prompts]]

## API endpoints called

- `/api/workspaces/:x/ai-config`
- `/api/workspaces/:x/ai-personalities/:x`
- `/api/workspaces/:x/ai-workflows/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/ai/page.tsx` — the page itself
- `src/app/dashboard/settings/ai/grader-rules/page.tsx` — sub-route
- `src/app/dashboard/settings/ai/prompts/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
