# Dashboard · developer

_TODO: page purpose._

**Route:** `/dashboard/developer`

## Features

**Page title:** Developer

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `approvals/` → [[developer/approvals]]
- `control-tower/` → [[developer/control-tower]]
- `messages/` → [[developer/messages]]
- `pulse/` → [[developer/pulse]]
- `regressions/` → [[developer/regressions]]
- `security-tests/` → [[developer/security-tests]]
- `spec-tests/` → [[developer/spec-tests]]

## API endpoints called

- `/api/branches`
- `/api/developer/approvals`
- `/api/developer/security-tests`
- `/api/developer/spec-test/human-queue`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/developer/page.tsx` — the page itself
- `src/app/dashboard/developer/approvals/page.tsx` — sub-route
- `src/app/dashboard/developer/control-tower/page.tsx` — sub-route
- `src/app/dashboard/developer/messages/page.tsx` — sub-route
- `src/app/dashboard/developer/pulse/page.tsx` — sub-route
- `src/app/dashboard/developer/regressions/page.tsx` — sub-route
- `src/app/dashboard/developer/security-tests/page.tsx` — sub-route
- `src/app/dashboard/developer/spec-tests/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
