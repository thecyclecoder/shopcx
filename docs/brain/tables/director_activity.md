# director_activity

The timestamped **action log** every director (and every worker a director supervises) writes a row to on each action it takes ([[../goals/devops-director]]). That single log is the substrate for **(1)** the autonomous-approval **audit history**, **(2)** the gamified [[../libraries/director-board|#directors board]] posts, and **(3)** the **EOD recap** — a read over *today's* rows, never hand-maintained.

Written via [[../libraries/director-activity]] `recordDirectorActivity` (best-effort, service-role only). The **first concrete writer** is the [[../specs/regression-agent|Regression Agent]] (a worker the Platform/DevOps Director supervises): every detect / dismiss / author / escalate action writes one row. The live directors (M4+) write the same shape (`approved_migration`, `fixed_bug`, `escorted_goal`, …).

**Workspace-scoped** (mirrors [[director_messages]] / [[spec_card_state]]). RLS: any authenticated user reads (the board + recap surfaces are owner-gated above the DB); service role does all writes.

**Migration:** `supabase/migrations/20260702120000_director_activity.sql` · apply via `npx tsx scripts/apply-director-activity-migration.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `director_function` | `text` | the function slug whose objective owns the action (e.g. `platform`); a **worker** action carries its **supervising director's** function |
| `action_kind` | `text` | what was done — **open vocabulary, no CHECK** (new kinds land without a migration). regression-agent emits: `detected_regression｜dismissed_regression｜authored_fix｜escalated`; the [[../libraries/agent-coaching|coaching pass]] emits: `coached_worker｜coaching_routed_to_repair｜escalated_coaching`; the [[../libraries/platform-director|Platform/DevOps Director]] emits: `approved_approval｜escorted_goal｜escorted_fix｜escorted_init｜escalated｜reconciled_error` (the last = [[../specs/director-zero-backlog-error-autonomy]] Phase 1 — one row per backlog action: an enqueued repair diagnosis or a stuck-fix escalation, `metadata: { signature, source, action: 'enqueued_repair'｜'escalated_stuck' }`) + (board-grooming) `groomed_continue｜groomed_split` + ([[../specs/director-supervised-repair-dismissal]] — supervising Rafa's no-fix items) `dismissed_repair｜kept_repair` (`metadata: { dismiss_key, repair_job_id, signature, verdict }`); a director proposing a goal emits `proposed_goal` ([[../specs/director-proposed-goals]] — written by `scripts/builder-worker.ts` `runProposedGoalJob` when the inert `proposed` artifact is committed, `metadata: { goal_slug, owner_function, proposer_function }`) |
| `spec_slug` | `text` | the spec the action touched (null for a non-spec action) |
| `reason` | `text` | the plain-text "why" — the reasoning the recap/audit reads back · default `''` |
| `metadata` | `jsonb` | structured per-action context: `{ job_id?, signature?, failing?, attempt?, verdict?, approver?, ... }` · default `{}` |
| `created_at` | `timestamptz` | default `now()` (the EOD recap filters `created_at >= today`) |

## Indexes

- `director_activity_ws_created_idx` on `(workspace_id, created_at desc)` — the recap/audit read.
- `director_activity_function_idx` on `(director_function, created_at desc)` — per-director slice.
- `director_activity_spec_idx` on `(spec_slug)` — per-spec audit slice.

## Related

[[../libraries/director-activity]] · [[../specs/regression-agent]] · [[../specs/security-dependency-agent]] · [[../libraries/security-agent]] · [[../goals/devops-director]] · [[../specs/director-loop-grading]] · [[../specs/worker-coaching-loop]] · [[../libraries/agent-coaching]] · [[../specs/board-grooming]] · [[../libraries/platform-director]] · [[director_messages]] · [[../libraries/director-board]]
