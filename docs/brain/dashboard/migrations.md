# Dashboard · migrations

The Appstle→internal **migration monitor** — "what's stuck?". Surfaces migrations whose verification checklist didn't pass so they're fixed **before the next renewal**. North star: a `failed` row is a renewal at risk.

**Route:** `/dashboard/migrations`

## Features

**Page title:** Migrations

**Rendering:** `"use client"` component (client-side state + fetch).

- **Counts** — Total / Passed / Pending / Failed across the workspace's [[../tables/migration_audits]].
- **Needs attention** — `failed` + `pending` audits, each as a card showing the 8 checks (✅/❌ + detail), the `appstle_contract_id → internal_contract_id` flip, a Recovery badge, and `status · retry {n}`.
- **Recently passed** — last 25 `passed` audits for context.

## Sub-routes

_None._

## API endpoints called

- `GET /api/migrations` — returns `{ counts, atRisk, recentPassed }` from `migration_audits` (limit 300, newest first). `src/app/api/migrations/route.ts`.

## Permissions

Owner-only in practice (the monitor is an internal billing-integrity tool). Gated by middleware auth + workspace membership; the API scopes to the cookie `workspace_id`.

## Where the rows come from

- Written inline at migration time by [[../libraries/migrate-to-internal]] → [[../libraries/migration-audit]] (`recordMigrationAudit` + `verifyMigration`).
- Re-verified by the [[../inngest/migration-audit-retry]] cron (every 10 min, pending rows).
- Back-filled for old-logic migrations by the [[../inngest/migration-integrity-sweep]] cron (daily).

## Files touched

- `src/app/dashboard/migrations/page.tsx` — the page itself
- `src/app/api/migrations/route.ts` — the data endpoint

---

[[../README]] · [[../tables/migration_audits]] · [[../libraries/migration-audit]] · [[../lifecycles/subscription-billing]] · [[../../CLAUDE]]
