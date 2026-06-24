# director_instructions

Per-director, versioned **guidance the CEO teaches the Director** — appended to her decision prompts at runtime so coaching changes what she does autonomously with **no deploy**. The top rung of the cascade: mirrors [[worker_instructions]] one level up (there a director coaches a worker; here the CEO coaches the director). Written by [[../libraries/director-instructions]] `coachDirector` (CEO-gated, from the [[director_coach_threads]] chat on approval); loaded into her prompts by `appendDirectorInstructions`. [[../specs/worker-grading-and-director-management]] Phase 7.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `director_function` | `text` | — | the director the guidance is for (e.g. `platform`) |
| `error_class` | `text` | — | the class of decision it addresses — the supersede/dedup key within a director |
| `guidance` | `text` | — | the learning: "when you see X, do Y instead" (appended to her decision prompts) |
| `triggering_pattern` | `text` | — | what the CEO was correcting · default `''` |
| `reasoning` | `text` | — | the "why" (the Z) · default `''` |
| `status` | `text` | — | `active｜superseded｜reverted` (open vocab) · default `active` |
| `version` | `int` | — | default 1 |
| `supersedes_id` | `uuid` | ✓ | → this.id · the prior version it replaced |
| `coached_by` | `text` | — | the coaching seat — `ceo` (never the director itself) · default `ceo` |
| `source_thread_id` | `uuid` | ✓ | → [[director_coach_threads]].id · the chat it was distilled from |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Indexes:** `(workspace_id, director_function, status, created_at desc)` (the runtime load — active guidance newest-first); `(director_function, error_class)` (supersede/dedup).

## Invariants
- **CEO-gated.** `coached_by` is the coaching seat (`ceo`); the director never edits her own instructions, and the table is service-role-write-only (her box session runs read-only). The north-star chain: CEO → director → worker.
- **Versioned + reversible.** A new active instruction supersedes the prior for the same `error_class` (the old flips `superseded`); a revert flips `reverted`. Only `active` guidance is loaded.
- **Injected, not deployed.** `appendDirectorInstructions` appends active guidance to her approval-investigation + board-grooming prompts every run, so a coached rule steers her next decision with no code change.

## RLS
Authenticated SELECT, service-role write — mirror [[worker_instructions]].

## Migration
`supabase/migrations/20260705140000_director_coaching.sql`. Idempotent.

---

[[../README]] · [[director_coach_threads]] · [[director_coaching_log]] · [[worker_instructions]] · [[../libraries/director-instructions]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
