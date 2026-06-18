# agent_jobs

The build queue for the [[../specs/roadmap-build-console]] "do it" button. One row per build of a spec. The dashboard inserts a `queued` row; the box worker ([[../recipes/build-box-setup]]) claims it via `claim_agent_job()`, runs `claude -p` on Max, and drives it to a `claude/*` PR. Distinct from [[agent_todos]] (the ticket-driven queue) — same shape, different driver.

**Two job kinds (`kind`).** The same queue + `claim_agent_job()` drives both — the worker branches on `kind`:
- `build` (default) — build a spec → `claude/*` PR (the original path). `spec_slug` = the spec.
- `plan` — the [[../specs/goal-decomposition-engine]] planner: decompose a GOAL (`spec_slug` = the **goal** slug) via the `plan-goal` skill. The plan pass proposes a milestone → spec tree back as `pending_actions` of `type:'spec'` (job → `needs_approval`); the owner approves branches (reusing `/api/roadmap/approve`); the worker resumes, authors exactly the approved specs + wikilinks them into the goal doc, then inserts a `kind='build'` row per authored spec (so the build pipeline takes over). Dispatched by `/api/roadmap/plan`; one active plan per goal.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `spec_slug` | `text` | `build`: the `docs/brain/specs/{slug}.md` to build · `plan`: the `docs/brain/goals/{slug}.md` to decompose |
| `kind` | `text` | `build` (default) ｜ `plan` — which worker driver runs. See above. |
| `spec_branch` | `text?` | `claude/{slug}-{rand}` the worker creates / reuses on resume |
| `instructions` | `text?` | optional extra build instructions |
| `status` | `text` | enum below · default `queued` |
| `claude_session_id` | `text?` | captured from `claude -p` stream; used for `claude --resume` |
| `questions` | `jsonb` | `[{id,q,options?}]` surfaced when `needs_input` · default `[]` |
| `answers` | `jsonb` | `[{id,q,answer}]` the owner submitted · default `[]` |
| `pending_actions` | `jsonb` | gated actions awaiting approval: `[{id,type,summary,cmd,preview,status,specSlug?}]`, type = `apply_migration｜run_prod_script｜merge_pr｜spec` · default `[]`. `spec` (plan jobs) carries `specSlug` and has no `cmd` — approving it authors that spec on resume, not a shell run. |
| `pr_url` / `pr_number` | `text?` / `int?` | the opened `claude/*` PR |
| `log_tail` | `text?` | last ~2 KB of the build output (debugging) |
| `error` | `text?` | failure reason |
| `claimed_at` | `timestamptz?` | set by `claim_agent_job()` |
| `created_by` | `uuid?` | owner who clicked Build |
| `created_at` / `updated_at` | `timestamptz` | |

## `status` enum

`queued` → `building` (claimed) → `completed` (PR open) · or pauses at → `needs_input` (product questions) / `needs_approval` (gated prod actions in `pending_actions`) → `queued_resume` (owner answered/approved; worker executes approved actions then `--resume`s) → `building` … · terminal failures: `failed`, `needs_attention` (pushed but PR failed). Active = `queued|claimed|building|needs_input|needs_approval|queued_resume` (one active build per spec).

## `claim_agent_job()`

`returns public.agent_jobs`. Grabs the oldest `queued`/`queued_resume` row `FOR UPDATE SKIP LOCKED`, flips it to `building`, returns it — atomic claim safe for concurrent workers. The worker calls it via `admin.rpc("claim_agent_job")`.

## Indexes / RLS

- `agent_jobs_ws_status_idx (workspace_id, status, created_at desc)` · `agent_jobs_slug_idx (workspace_id, spec_slug, created_at desc)`.
- RLS: `agent_jobs_select` (workspace members read) · `agent_jobs_service` (service role all writes). The box worker uses the service role.

## Gotchas

- **One active build per spec** — `POST /api/roadmap/build` refuses a new job if an active one exists for the slug.
- **Status changes don't move the card live** on the board until reload; `BuildButton` polls `/api/roadmap/build?slug=` while active.
- A build that pauses (`needs_input`) keeps `claude_session_id`; answering (`/api/roadmap/answer`) sets `queued_resume` and the worker resumes that exact session.

## Migration

`supabase/migrations/20260618120000_agent_jobs.sql` + `20260618130000_agent_jobs_pending_actions.sql` + `20260618140000_agent_jobs_kind.sql` (the `kind` column)

## Related

[[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../specs/goal-decomposition-engine]] · [[../lifecycles/roadmap-build-console]] · [[../recipes/build-box-setup]] · [[../dashboard/roadmap]] · [[../dashboard/branches]] · [[agent_todos]]
