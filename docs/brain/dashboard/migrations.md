# Dashboard · migrations

The Appstle→internal **migration monitor** — "what's stuck?". Surfaces migrations whose verification checklist didn't pass so they're fixed **before the next renewal**. North star: a `failed` row is a renewal at risk.

**Route:** `/dashboard/migrations`

## Features

**Page title:** Migrations

**Rendering:** `"use client"` component (client-side state + fetch).

- **Counts** — Total / Passed / Pending / Failed across the workspace's [[../tables/migration_audits]].
- **Needs attention** — `failed` + `pending` audits, each as a card showing the 8 checks (✅/❌ + detail), the `appstle_contract_id → internal_contract_id` flip, a Recovery badge, and `status · retry {n}`.
- **🤖 Migration-fix panel** ([[../specs/migration-fix-agent]]) — when the [[../specs/migration-fix-agent|migration-fix box agent]] has worked a `failed` row, the card shows its **written diagnosis** and, when it proposed a fix, the typed action(s) (`price_reconcile`/`variant_backfill`/`appstle_cancel`/`shipping_protection_convert`) with **Approve & fix** / Decline buttons (owner-only). Approving calls `/api/roadmap/approve` → the worker executes the fix via [[../libraries/migration-fix]] `applyMigrationFix` + re-runs `verifyMigration`; only a re-`passed` clears the row. `/api/migrations` joins the latest `kind='migration-fix'` [[../tables/agent_jobs]] row (by `spec_slug = audit id`) onto each at-risk audit as `fix:{jobId,status,diagnosis,error,questions,actions}`.
  - **Plain question + inline answer** ([[../specs/migration-fix-human-input]]) — for a **human-JUDGMENT** case (e.g. an ambiguous grandfathered price), the box pauses on **`needs_input`** with **one plain-language question** (the job's `questions [{id,q}]`) instead of dumping check-jargon. The panel renders the question prominently + a **text input** per question + a general free-text **note** box + **Send** (owner-only). Send reuses **`POST /api/roadmap/answer`** (`{jobId, answers:[{id,q,answer}]}`) → the job flips `queued_resume`; the box resumes WITH the answer and proposes a concrete gated fix (→ the existing **Approve & fix**). A non-owner sees "Owner answer required."
  - **Out-of-system** (no billable card anywhere) stays terminal `human_needed` — the diagnosis is a **one-line plain instruction** ("Ask {customer} to add a card; this sub can't bill until then"), no buttons.
  - **Code-gap escalation** ([[../specs/migration-fix-agent]] Phase 2) — for a **recurring** code/data gap the box returns `status:'code_gap'` (job `error='code-gap'`): it commits a permanent fix **spec** to `docs/brain/specs/` (surfaced on the Roadmap board to commission a build), and the row stays `failed` with the diagnosis in `log_tail` (the spec fixes the class, not this renewal).
- **Recently passed** — last 25 `passed` audits for context.

## Sub-routes

_None._

## API endpoints called

- `GET /api/migrations` — returns `{ counts, atRisk, recentPassed }` from `migration_audits` (limit 300, newest first); each at-risk row gets a joined `fix` (incl. `questions` for a `needs_input` pause) from its latest `kind='migration-fix'` [[../tables/agent_jobs]] row. `src/app/api/migrations/route.ts`.
- `POST /api/roadmap/approve` `{ jobId, actionId, decision }` — owner approves/declines a proposed migration-fix action (the shared [[../specs/build-approval-gates|approval-gate]] route → `queued_resume`).
- `POST /api/roadmap/answer` `{ jobId, answers:[{id,q,answer}] }` — owner answers a `needs_input` judgment question inline ([[../specs/migration-fix-human-input]]); flips the job `queued_resume` so the box re-diagnoses WITH the answer.

## Permissions

Owner-only in practice (the monitor is an internal billing-integrity tool). Gated by middleware auth + workspace membership; the API scopes to the cookie `workspace_id`.

## Where the rows come from

- Written inline at migration time by [[../libraries/migrate-to-internal]] → [[../libraries/migration-audit]] (`recordMigrationAudit` + `verifyMigration`).
- Re-verified by the [[../inngest/migration-audit-retry]] cron (every 10 min, pending rows).
- Back-filled for old-logic migrations by the [[../inngest/migration-integrity-sweep]] cron (daily).
- Worked on the `failed` transition by the [[../specs/migration-fix-agent|migration-fix box agent]] (event-driven, not a cron) — diagnosis + proposed fix join in via the migration-fix [[../tables/agent_jobs]] row.

## Files touched

- `src/app/dashboard/migrations/page.tsx` — the page itself
- `src/app/api/migrations/route.ts` — the data endpoint

---

[[../README]] · [[../tables/migration_audits]] · [[../libraries/migration-audit]] · [[../libraries/migration-fix]] · [[../specs/migration-fix-agent]] · [[../lifecycles/subscription-billing]] · [[../../CLAUDE]]
