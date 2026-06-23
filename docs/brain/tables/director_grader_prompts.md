# director_grader_prompts

The **human-approved calibration store** for the director-decision grader — so the CEO corrects the grader's scoring on edge cases, exactly as [[grader_prompts]] calibrates the ticket grader and [[storefront_grader_prompts]] the campaign grader. Only `status='approved'` rules are injected into [[../libraries/director-grader]]'s prompt. Part of [[../specs/director-loop-grading]] Phase 2 (M5 of [[../goals/devops-director]]).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `title` | `text` | — | |
| `content` | `text` | — | the calibration rule injected into the grader prompt when `approved` |
| `status` | `text` | — | default `proposed` · CHECK ∈ `proposed` \| `approved` \| `rejected` \| `archived` |
| `derived_from_decision_id` | `uuid` | ✓ | → [[approval_decisions]].id · ON DELETE SET NULL · the decision an override was born on |
| `derived_from_grade_id` | `uuid` | ✓ | → [[director_decision_grades]].id · ON DELETE SET NULL |
| `proposed_at` | `timestamptz` | ✓ | default `now()` |
| `reviewed_at` | `timestamptz` | ✓ | |
| `reviewed_by` | `uuid` | ✓ | |
| `sort_order` | `int` | ✓ | default 100 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Indexes:** `(workspace_id, status)`.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `derived_from_decision_id` → [[approval_decisions]].id · `derived_from_grade_id` → [[director_decision_grades]].id.

## Invariants
- **Only `approved` rules calibrate.** A `proposed` rule is inert until the CEO approves it — the grader's scoring changes only by owner action.
- **Overrides are never lost.** A CEO override on a [[director_decision_grades]] row (a large grade gap) proposes a rule here (`status='proposed'`, `derived_from_grade_id` set) — the correction becomes durable calibration, not a one-off.

## RLS
Authenticated SELECT (owner-gated above the DB), service-role write — mirror [[approval_decisions]].

## Migration
`supabase/migrations/20260704120000_director_decision_grades.sql` (apply: `npx tsx scripts/apply-director-decision-grades-migration.ts`). Idempotent.

---

[[../README]] · [[director_decision_grades]] · [[grader_prompts]] · [[storefront_grader_prompts]] · [[../specs/director-loop-grading]] · [[../goals/devops-director]] · [[../../CLAUDE]]
