# worker_action_grades

The DevOps Director's **worker-action grade** — one row per graded **worker action**, scoring it 1–10 with reasoning. The supervisory feedback signal that closes the **CEO → Director → Worker** cascade ([[../specs/worker-grading-and-director-management]] P1). One level **down** the org chart from [[director_decision_grades]] (there the CEO grades the [[../specs/platform-director-agent|Platform/DevOps Director]]'s calls; here the Director grades each [[agent_jobs|worker]]'s concluded actions). Written by [[../libraries/worker-grader]] `gradeWorkerAction` / `gradeConcludedWorkerActions`; overridable by the Director/CEO.

**Gradeable unit:** ONE concluded [[agent_jobs]] row — the worker's atomic action (a build merged, an error fixed/dismissed, an index proposed, a spec verified). No polymorphic key (the one-level-down simplification vs [[director_decision_grades]], where a call is an auto-approval OR a goal-escort).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `worker_kind` | `text` | — | the [[agent_jobs]] `kind` graded (e.g. `build`, `repair`, `db_health`, `spec-test`) |
| `agent_job_id` | `uuid` | — | → [[agent_jobs]].id · ON DELETE CASCADE · the concluded job this grade scores |
| `grade` | `int` | ✓ | 1–10 · CHECK |
| `reasoning` | `text` | ✓ | the grader's stated "why" — craft vs outcome kept distinct (auditable) |
| `graded_by` | `text` | — | default `agent` · CHECK ∈ `agent` \| `human` |
| `overridden_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL · the member who overrode |
| `override_reason` | `text` | ✓ | |
| `overridden_at` | `timestamptz` | ✓ | |
| `model` | `text` | ✓ | grader model |
| `input_tokens` / `output_tokens` | `int` | ✓ | default 0 |
| `cost_cents` | `numeric(10,4)` | ✓ | default 0 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(agent_job_id)` — one grade per concluded job (idempotent grading; a re-run UPDATEs in place, never duplicates).

**Indexes:** `(workspace_id, created_at desc)`; `(workspace_id, worker_kind, created_at desc)` — the per-worker **last-10 rollup** + trend lookup ([[../libraries/worker-grader]] `computeWorkerRollup`).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `agent_job_id` → [[agent_jobs]].id · `overridden_by` → `auth.users`.id.

**In:** [[worker_grader_prompts]].`derived_from_grade_id` → this.

## Invariants
- **Craft over luck.** The grader scores **craft separately from outcome** — a worker whose disposition was sound but hit a rare external bump still grades well; a clean outcome reached by luck while skipping the work grades low. Mirrors [[director_decision_grades]]'s soundness-vs-outcome split.
- **Concluded-only.** A job is gradeable only once it reaches a terminal status (`completed｜failed｜needs_attention`); an in-flight job returns `not_concluded` and is retried next batch.
- **Idempotent.** One grade per job (the `agent_job_id` unique) — a re-grade updates in place.
- **Human-overridable.** An override sets `graded_by='human'` + `overridden_by`; the agent never re-writes a human grade.
- **The rollup only recommends.** A slipping last-10 rollup (`< 7` or a `> 1.5` drop) triggers a [[worker_coaching_log|coachWorker]] pass — reversible guidance within the leash; it never demotes a worker by itself ([[../operational-rules]] § North star).

## RLS
Authenticated SELECT (the worker-profile report is owner-gated above the DB), service-role write — mirror [[director_decision_grades]].

## Migration
`supabase/migrations/20260705130000_worker_action_grades.sql` (apply: `npx tsx scripts/apply-worker-action-grades-migration.ts`). Idempotent. Creates this + [[worker_grader_prompts]].

---

[[../README]] · [[worker_grader_prompts]] · [[agent_jobs]] · [[director_decision_grades]] · [[worker_coaching_log]] · [[worker_instructions]] · [[../libraries/worker-grader]] · [[../specs/worker-grading-and-director-management]] · [[../goals/devops-director]] · [[../../CLAUDE]]
