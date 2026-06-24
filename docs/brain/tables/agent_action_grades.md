# agent_action_grades

The DevOps Director's **worker-action grade** — one row per graded **concluded `agent_jobs` row**, scoring the worker's atomic action 1–10 with reasoning. The supervisory feedback signal one level **down** the org chart from [[director_decision_grades]] (there the CEO grades the [[../specs/platform-director-agent|Director]]'s calls; here the Director grades each WORKER's actions), closing the **CEO → Director → Worker** cascade for [[../goals/devops-director]] ([[../specs/worker-grading-and-director-management]] Phase 1). Written by [[../libraries/agent-grader]] `gradeAgentAction`; the standing rollup feeds the coaching trigger; overridable by the CEO/Director.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `agent_job_id` | `uuid` | — | → [[agent_jobs]].id · ON DELETE CASCADE · **the gradeable unit** — the concluded job this scores |
| `agent_kind` | `text` | — | the worker (= `agent_jobs.kind`, e.g. `build`/`repair`/`db_health`) — **denormalized** so the last-10 rollup is a single index scan, never a join |
| `spec_slug` | `text` | ✓ | the spec/target the action was for (report context; no FK — specs are markdown) |
| `grade` | `int` | ✓ | 1–10 · CHECK |
| `reasoning` | `text` | ✓ | the grader's stated "why" (auditable, against the worker's rubric) |
| `graded_by` | `text` | — | default `agent` · CHECK ∈ `agent` \| `human` |
| `overridden_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL · the member who overrode |
| `override_reason` | `text` | ✓ | |
| `overridden_at` | `timestamptz` | ✓ | |
| `model` | `text` | ✓ | grader model |
| `input_tokens` / `output_tokens` | `int` | ✓ | default 0 |
| `cost_cents` | `numeric(10,4)` | ✓ | default 0 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(agent_job_id)` — one grade per concluded job. Idempotent grading; a re-run UPDATEs in place, never duplicates, never clobbers a human override.

**Indexes:** `(workspace_id, created_at desc)` (report ordering); `(workspace_id, agent_kind, created_at desc)` (the last-10 rollup + trend per worker — [[../libraries/agent-grader]] `computeAgentRollup`).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `agent_job_id` → [[agent_jobs]].id · `overridden_by` → `auth.users`.id.

**In:** [[agent_grader_prompts]].`derived_from_grade_id` → this · `derived_from_job_id` → [[agent_jobs]].id.

## Invariants
- **Grade the work, not outcome luck.** A sound, well-scoped action that hit a rare reversible bump still grades well if the reasoning was right; a careless action that happened to land grades low — mirror [[director_decision_grades]]'s soundness-over-luck rule.
- **Per-worker rubric.** Each `agent_kind` is scored against its own rubric (the spec's locked config, in [[../libraries/agent-grader]] `AGENT_RUBRICS`) — a `build` on spec-phases-satisfied/`tsc`-clean/clean-merge, a `repair` on real-root-cause/fix-held, etc. Only rubric-backed kinds are graded (the Director's own + non-worker kinds are excluded).
- **Human-overridable.** An override sets `graded_by='human'` + `overridden_by`; the agent never re-writes a human grade. A large override gap proposes a [[agent_grader_prompts]] calibration rule.
- **Idempotent.** One grade per concluded job (the unique on `agent_job_id`) — a re-grade updates in place.
- **The grade only recommends.** The rollup drives a *coaching* trigger ([[../libraries/agent-grader]] `detectGradeDropCoaching` → [[../libraries/agent-instructions|coachAgent]]), not a self-promotion — the Director coaches; the leash changes only by CEO confirmation ([[../operational-rules]] § North star).

## RLS
Authenticated SELECT (the worker-profile report is owner-gated above the DB), service-role write — mirror [[agent_coaching_log]] / [[director_decision_grades]].

## Migration
`supabase/migrations/20260705120000_worker_action_grades.sql` (apply: `npx tsx scripts/apply-worker-action-grades-migration.ts`). Idempotent. Creates this + [[agent_grader_prompts]].

---

[[../README]] · [[agent_grader_prompts]] · [[agent_jobs]] · [[agent_coaching_log]] · [[director_decision_grades]] · [[../libraries/agent-grader]] · [[../specs/worker-grading-and-director-management]] · [[../goals/devops-director]] · [[../../CLAUDE]]
