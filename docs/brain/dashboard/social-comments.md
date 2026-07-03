# Dashboard · social-comments

Moderation queue for inbound Meta + Instagram comments. Filters by sentiment / category / status. Per-comment: reply / hide / delete / regenerate AI / ban sender.

**Route:** `/dashboard/social-comments`

## Features

**Page title:** Social comments

**Filters:**
- status: all, open, escalated, replied, closed, ignored, hidden, deleted
- sentiment: all, positive, negative, neutral, spam, abusive

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[social-comments/[id]]]
- `analysis/` → [[social-comments/analysis]]
- `banned/` → [[social-comments/banned]]

## API endpoints called

- `/api/workspaces/:x/meta-pages`
- `/api/workspaces/:x/social-comments`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/social-comments/page.tsx` — the page itself
- `src/app/dashboard/social-comments/[id]/page.tsx` — sub-route
- `src/app/dashboard/social-comments/analysis/page.tsx` — sub-route
- `src/app/dashboard/social-comments/banned/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
