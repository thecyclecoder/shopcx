# director_decision_grades

The CEO's **director-decision grade** — one row per graded **director call**, scoring it 1–10 with reasoning. The supervisory feedback signal that closes the **CEO → Director → tool** chain for [[../goals/devops-director]] (M5, [[../specs/director-loop-grading]] Phase 2). One level up the org chart from [[storefront_campaign_grades]] (there the Head-of-Growth grades the Optimizer's campaigns; here the CEO grades the [[../specs/platform-director-agent|Platform/DevOps Director]]'s calls). Written by [[../libraries/director-grader]] `gradeDirectorCall` (Phase 3); overridable by the CEO.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `dimension` | `text` | — | CHECK ∈ `auto-approval` \| `goal-escort` — which kind of director call this grades |
| `approval_decision_id` | `uuid` | ✓ | → [[approval_decisions]].id · ON DELETE CASCADE · set for `dimension='auto-approval'` |
| `goal_slug` | `text` | ✓ | the escorted goal (lives in `docs/brain/goals`, **no FK**) · set for `dimension='goal-escort'` |
| `milestone` | `text` | ✓ | the escorted milestone (e.g. `M4`) · set for `dimension='goal-escort'` |
| `grade` | `int` | ✓ | 1–10 · CHECK |
| `reasoning` | `text` | ✓ | the grader's stated "why" (auditable) |
| `graded_by` | `text` | — | default `agent` · CHECK ∈ `agent` \| `human` |
| `overridden_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL · the member who overrode |
| `override_reason` | `text` | ✓ | |
| `overridden_at` | `timestamptz` | ✓ | |
| `model` | `text` | ✓ | grader model |
| `input_tokens` / `output_tokens` | `int` | ✓ | default 0 |
| `cost_cents` | `numeric(10,4)` | ✓ | default 0 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Key shape (CHECK `director_decision_grades_key_shape`):** exactly one of `approval_decision_id` (when `dimension='auto-approval'`) or `goal_slug`+`milestone` (when `dimension='goal-escort'`) — never both, never neither.

**Unique:** partial `(approval_decision_id) where approval_decision_id is not null` (one grade per auto-approval); partial `(workspace_id, goal_slug, milestone) where dimension='goal-escort'` (one grade per escorted milestone) — idempotent grading; a re-run UPDATEs in place, never duplicates.

**Indexes:** `(workspace_id, created_at desc)`; `(workspace_id, dimension, created_at desc)` (per-dimension report + trend — Phase 4).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `approval_decision_id` → [[approval_decisions]].id · `overridden_by` → `auth.users`.id. (`goal_slug` is intentionally FK-less — the goal lives in `docs/brain/goals`, not a table.)

**In:** [[director_grader_prompts]].`derived_from_grade_id` → this.

## Invariants
- **Soundness over luck.** A sound auto-approval that later needed a rare, reversible tweak still grades well if the *reasoning* was right; a careless approval that happened to be fine grades low — mirror [[storefront_campaign_grades]]'s hypothesis-vs-result separation.
- **Human-overridable.** An override sets `graded_by='human'` + `overridden_by`; the agent never re-writes a human grade. A large override gap proposes a [[director_grader_prompts]] calibration rule.
- **Idempotent.** One grade per call per dimension (the partial uniques) — a re-grade updates in place.
- **The grade only recommends.** Grades feed Phase-4 leash-adjustment *recommendations*; the `live + autonomous` envelope changes only by CEO confirmation — the director never self-promotes ([[../operational-rules]] § North star).

## RLS
Authenticated SELECT (the Agents-hub report is owner-gated above the DB), service-role write — mirror [[approval_decisions]].

## Migration
`supabase/migrations/20260704120000_director_decision_grades.sql` (apply: `npx tsx scripts/apply-director-decision-grades-migration.ts`). Idempotent.

---

[[../README]] · [[director_grader_prompts]] · [[approval_decisions]] · [[../specs/director-loop-grading]] · [[storefront_campaign_grades]] · [[../goals/devops-director]] · [[../../CLAUDE]]
