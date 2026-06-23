# worker_grader_prompts

The **human-approved calibration store** for the worker-action grader — so the CEO corrects the Director's per-worker scoring on edge cases, exactly as [[director_grader_prompts]] calibrates the director grader one level up. Only `status='approved'` rules are injected into [[../libraries/worker-grader]]'s prompt (filtered to the worker the rule targets, or to every worker when `worker_kind IS NULL`). Part of [[../specs/worker-grading-and-director-management]] Phase 1 (the devops-director goal).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `worker_kind` | `text` | ✓ | the worker (= `agent_jobs.kind`) this rubric correction targets · **NULL = applies to every worker** (a cross-cutting calibration rule) |
| `title` | `text` | — | |
| `content` | `text` | — | the calibration rule injected into the grader prompt when `approved` |
| `status` | `text` | — | default `proposed` · CHECK ∈ `proposed` \| `approved` \| `rejected` \| `archived` |
| `derived_from_job_id` | `uuid` | ✓ | → [[agent_jobs]].id · ON DELETE SET NULL · the concluded job an override was born on |
| `derived_from_grade_id` | `uuid` | ✓ | → [[worker_action_grades]].id · ON DELETE SET NULL |
| `proposed_at` | `timestamptz` | ✓ | default `now()` |
| `reviewed_at` | `timestamptz` | ✓ | |
| `reviewed_by` | `uuid` | ✓ | |
| `sort_order` | `int` | ✓ | default 100 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Indexes:** `(workspace_id, status)`; `(workspace_id, worker_kind, status)` (per-worker rubric lookup — the worker-specific rows + the cross-cutting NULL rows).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `derived_from_job_id` → [[agent_jobs]].id · `derived_from_grade_id` → [[worker_action_grades]].id.

## Invariants
- **Only `approved` rules calibrate.** A `proposed` rule is inert until the CEO approves it — the grader's scoring changes only by owner action.
- **Targeted or cross-cutting.** A rule with a `worker_kind` calibrates only that worker's grading; `worker_kind IS NULL` applies to every worker.
- **Overrides are never lost.** A CEO override on a [[worker_action_grades]] row (a large grade gap) proposes a rule here (`status='proposed'`, `derived_from_grade_id` set) — the correction becomes durable calibration, not a one-off.

## RLS
Authenticated SELECT (owner-gated above the DB), service-role write — mirror [[worker_coaching_log]] / [[director_grader_prompts]].

## Migration
`supabase/migrations/20260705120000_worker_action_grades.sql` (apply: `npx tsx scripts/apply-worker-action-grades-migration.ts`). Idempotent. Created alongside [[worker_action_grades]].

---

[[../README]] · [[worker_action_grades]] · [[director_grader_prompts]] · [[../libraries/worker-grader]] · [[../specs/worker-grading-and-director-management]] · [[../goals/devops-director]] · [[../../CLAUDE]]
