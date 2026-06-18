# agent_jobs

The build queue for the [[../specs/roadmap-build-console]] "do it" button. One row per job. The dashboard inserts a `queued` row; the box worker ([[../recipes/build-box-setup]]) claims it via `claim_agent_job()`, runs `claude -p` on Max, and drives it to a `claude/*` PR. Distinct from [[agent_todos]] (the ticket-driven queue) — same shape, different driver.

**Three `kind`s off one queue + RPC:** `'build'` (default — build a spec to a PR), `'plan'` (the [[../specs/goal-decomposition-engine|goal-decomposition engine]] — run the `plan-goal` skill against a goal → propose a milestone→spec tree → on approval, auto-author the specs + queue their builds), and `'fold'` (the [[../specs/fold-build-batching|fold-build batcher]] — fold **every** [[pending_folds|pending-fold]] spec for the workspace into the brain in **one** PR). The worker branches on `kind` (`runJob` / `runPlanJob` / `runFoldJob`). For a plan job, `spec_slug` holds the **goal** slug; for a fold job it's the `'fold-batch'` sentinel (the real spec list lives in [[pending_folds]]).

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `kind` | `text` | `build` (default) ｜ `plan` ｜ `fold` — the job kind the worker branches on |
| `spec_slug` | `text` | for `build`: the `docs/brain/specs/{slug}.md` to build · for `plan`: the `docs/brain/goals/{slug}.md` to plan |
| `spec_branch` | `text?` | `claude/{slug}-{rand}` the worker creates / reuses on resume |
| `instructions` | `text?` | optional extra build/plan instructions |
| `status` | `text` | enum below · default `queued` |
| `claude_session_id` | `text?` | captured from `claude -p` stream; used for `claude --resume` |
| `questions` | `jsonb` | `[{id,q,options?}]` surfaced when `needs_input` · default `[]` |
| `answers` | `jsonb` | `[{id,q,answer}]` the owner submitted · default `[]` |
| `pending_actions` | `jsonb` | gated actions awaiting approval: `[{id,type,summary,cmd,preview,status,spec?}]`, type = `apply_migration｜run_prod_script｜merge_pr｜spec` · default `[]`. `type:'spec'` is a planner-proposed branch carrying `spec:{slug,title,owner,parent,milestone,intent,gap}`; the worker authors it on approval |
| `pr_url` / `pr_number` | `text?` / `int?` | the opened `claude/*` PR |
| `log_tail` | `text?` | last ~2 KB of the build output (debugging) |
| `error` | `text?` | failure reason |
| `claimed_at` | `timestamptz?` | set by `claim_agent_job()` |
| `created_by` | `uuid?` | owner who clicked Build |
| `created_at` / `updated_at` | `timestamptz` | |

## `status` enum

`queued` → `building` (claimed) → `completed` (PR open) · or pauses at → `needs_input` (product questions) / `needs_approval` (gated prod actions in `pending_actions`) → `queued_resume` (owner answered/approved; worker executes approved actions then `--resume`s) → `building` … · terminal failures: `failed`, `needs_attention` (pushed but PR failed). Active = `queued|claimed|building|needs_input|needs_approval|queued_resume` (one active build per spec).

## `claim_agent_job(p_kinds text[] default null)`

`returns public.agent_jobs`. Grabs the oldest `queued`/`queued_resume` row `FOR UPDATE SKIP LOCKED`, flips it to `building`, returns it — atomic claim safe for concurrent workers. `p_kinds` filters by kind (NULL = any). The worker runs **per-kind concurrency** ([[../specs/fold-build-batching]] Phase 2): it claims `['build','plan']` into a 5-lane pool and `['fold']` into a **concurrency-1** lane, so a fold never races a feature build on the (now generated) index files. Replaced the old zero-arg overload (dropped first — a defaulted overload would be ambiguous on a no-arg call).

## `enqueue_fold(p_workspace, p_slug, p_user)`

`returns public.agent_jobs`. The atomic coalesce behind "Mark verified & archive": marks the spec [[pending_folds|pending-fold]] and ensures **exactly one** `queued` `kind='fold'` job for the workspace exists (reuses it if present — the spec joins that batch — else inserts one), returning it. Serialized per-workspace by `pg_advisory_xact_lock` so two simultaneous verifies can't open a double fold job; a partial unique index `agent_jobs_one_queued_fold_idx (workspace_id) where kind='fold' and status='queued'` is the belt-and-suspenders. Specs verified while a fold is mid-flight ride the **next** queued job, never the in-flight snapshot.

## Indexes / RLS

- `agent_jobs_ws_status_idx (workspace_id, status, created_at desc)` · `agent_jobs_slug_idx (workspace_id, spec_slug, created_at desc)` · `agent_jobs_one_queued_fold_idx (workspace_id) where kind='fold' and status='queued'` (≤1 queued fold per workspace).
- RLS: `agent_jobs_select` (workspace members read) · `agent_jobs_service` (service role all writes). The box worker uses the service role.

## Plan jobs (goal-decomposition engine)

A `kind='plan'` job runs the `plan-goal` skill in `runPlanJob`:
- **First run** — propose a milestone→spec tree. The planner writes nothing; its `needs_approval` output becomes `pending_actions` (one `type:'spec'` per branch, each carrying its `spec` payload). No PR. Proposals missing owner/parent are dropped (no-orphan rule).
- **Resume** (owner approved/declined via `/api/roadmap/approve` → `queued_resume`) — author the **approved** specs to `docs/brain/specs/`, wikilink them into the goal doc's `## Decomposition`, commit those docs **straight to main** via the GitHub Contents API (the `chat/finalize` pattern — so the builds queued next find their specs on `origin/main`), record declines as ❌, then insert a `kind='build'` row per approved spec. One terminal `completed`; no planning PR (builds open their own `claude/*` PRs). See [[../specs/goal-decomposition-engine]].

## Gotchas

- **One active build per spec / one active plan per goal** — `POST /api/roadmap/build` and `/api/roadmap/plan` refuse a new job if an active one (`queued|claimed|building|needs_input|needs_approval|queued_resume`) exists for that slug.
- **Status changes don't move the card live** on the board until reload; `BuildButton` polls `/api/roadmap/build?slug=` while active.
- A build that pauses (`needs_input`) keeps `claude_session_id`; answering (`/api/roadmap/answer`) sets `queued_resume` and the worker resumes that exact session.

## Migration

`supabase/migrations/20260618120000_agent_jobs.sql` + `20260618130000_agent_jobs_pending_actions.sql` + `20260618150000_agent_jobs_kind.sql` (adds `kind`) + `20260618160000_fold_batching.sql` (kind-aware `claim_agent_job`, `enqueue_fold`, `agent_jobs_one_queued_fold_idx`, [[pending_folds]])

## Related

[[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../specs/goal-decomposition-engine]] · [[../specs/fold-build-batching]] · [[pending_folds]] · [[../lifecycles/roadmap-build-console]] · [[../recipes/build-box-setup]] · [[../recipes/manage-the-build-queue]] · [[../dashboard/roadmap]] · [[../dashboard/branches]] · [[agent_todos]]
