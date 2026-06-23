# worker_grader_prompts

The **human-approved (CEO-calibratable) rubric store** for the worker-action grader — so the CEO/Director corrects the grader's scoring on edge cases, exactly as [[director_grader_prompts]] calibrates the director grader one level up. Only `status='approved'` rules are injected into [[../libraries/worker-grader]]'s prompt. Part of [[../specs/worker-grading-and-director-management]] P1.

A rule is **per-worker** (`worker_kind` set → applies only to that worker) or **global** (`worker_kind` null → applies to every worker). The grader injects rules where `worker_kind is null OR worker_kind = <the worker being graded>`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `worker_kind` | `text` | ✓ | the [[agent_jobs]] `kind` this rule calibrates · NULL = global (all workers) |
| `title` | `text` | — | |
| `content` | `text` | — | the calibration rule injected into the grader prompt when `approved` |
| `status` | `text` | — | default `proposed` · CHECK ∈ `proposed` \| `approved` \| `rejected` \| `archived` |
| `derived_from_job_id` | `uuid` | ✓ | → [[agent_jobs]].id · ON DELETE SET NULL · the job an override was born on |
| `derived_from_grade_id` | `uuid` | ✓ | → [[worker_action_grades]].id · ON DELETE SET NULL |
| `proposed_at` | `timestamptz` | ✓ | default `now()` |
| `reviewed_at` | `timestamptz` | ✓ | |
| `reviewed_by` | `uuid` | ✓ | |
| `sort_order` | `int` | ✓ | default 100 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Indexes:** `(workspace_id, status)`.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `derived_from_job_id` → [[agent_jobs]].id · `derived_from_grade_id` → [[worker_action_grades]].id.

## Invariants
- **Only `approved` rules calibrate.** A `proposed` rule is inert until the CEO approves it — the grader's scoring changes only by owner action.
- **The base rubric is per-worker.** The static "what 10 means" per worker lives in [[../libraries/worker-grader]]'s `RUBRICS` map (the spec's rubric table); this store is the **calibration layer** on top.

## RLS
Authenticated SELECT (owner-gated above the DB), service-role write — mirror [[director_grader_prompts]].

## Migration
`supabase/migrations/20260705130000_worker_action_grades.sql` (apply: `npx tsx scripts/apply-worker-action-grades-migration.ts`). Idempotent. Created alongside [[worker_action_grades]].

---

[[../README]] · [[worker_action_grades]] · [[director_grader_prompts]] · [[../libraries/worker-grader]] · [[../specs/worker-grading-and-director-management]] · [[../goals/devops-director]] · [[../../CLAUDE]]
