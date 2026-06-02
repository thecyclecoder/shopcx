# Settings · settings/patterns

Smart patterns CRUD — global + workspace-scoped, with embedding regeneration.

**Route:** `/dashboard/settings/patterns`

## Features

**Page title:** Smart Patterns

**Visible buttons (heuristic — actual labels in source):**
- Generate Embeddings
- New Pattern
- Cancel
- Mark Applied
- Dismiss
- Edit
- Delete

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/pattern-feedback`
- `/api/workspaces/:x/pattern-feedback/:x`
- `/api/workspaces/:x/patterns`
- `/api/workspaces/:x/patterns/:x`
- `/api/workspaces/:x/patterns/:x/override`
- `/api/workspaces/:x/patterns/generate-embeddings`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/patterns/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
