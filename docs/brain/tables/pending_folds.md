# pending_folds

The set of shipped specs queued to fold, awaiting (or mid-) a batch fold-build ([[../specs/fold-build-batching]]). A row is enqueued when a spec's **machine spec-test passes** (Gate B `autoFoldVerifiedSpecs`, fold-on-spec-test-pass task #29) — or by the owner's optional manual **Fold to brain now** override; human QA is advisory and does NOT enqueue here. One row per spec per workspace. Decouples "this spec should be folded" from the [[agent_jobs|fold job]] that does it: N enqueues coalesce into **one** `kind='fold'` job that folds every `pending` row in a single PR — instead of one fold PR per spec all colliding on `archive.md`/README.

**Primary key:** `id` · **Unique:** `(workspace_id, spec_slug)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `spec_slug` | `text` | the `docs/brain/specs/{slug}.md` to fold + retire |
| `status` | `text` | `pending` ｜ `folding` ｜ `folded` ｜ `failed` · default `pending` |
| `job_id` | `uuid?` | → [[agent_jobs]].id · the fold job that claimed this row · ON DELETE SET NULL |
| `requested_by` | `uuid?` | owner who clicked "Mark verified & archive" |
| `created_at` / `updated_at` | `timestamptz` | |

## `status` lifecycle

`pending` (queued for the next fold batch) → `folding` (a fold job snapshotted it — bound via `job_id`) → `folded` (the fold PR opened). On fold-build failure the rows reset `folding → pending` (`job_id` cleared) so a re-verify re-batches them. Only `pending|folding` rows show on the board (as **"Folding…"**); `folded` rows drop off once the PR merges + the spec is `git rm`'d.

## How it's written

- **Enqueue** — `POST /api/roadmap/build {verify:true}` → `enqueue_fold(ws, slug, user)` ([[agent_jobs]]): upserts the row to `pending` (leaving a `pending`/`folding` row untouched) and ensures one `queued` fold job. Atomic under a per-workspace advisory lock.
- **Snapshot** — when the worker's `runFoldJob` claims the fold job, it atomically flips every `pending` row for the workspace to `folding` + `job_id` (one `UPDATE … RETURNING`). Rows added after that ride the **next** queued fold job, never this in-flight snapshot.
- **Read** — `getPendingFolds(workspaceId)` (`src/lib/agent-jobs.ts`) returns the live (`pending|folding`) rows keyed by slug, with their fold job joined, for the board's per-card status.
- **Stranded-fold backstop** ([[../specs/fold-never-strands-a-shipped-spec-with-a-zero-machine-check-spec-test]] Phase 1) — the periodic **fold-queue reaper** (`runFoldQueueReaperJob` in [[../../../scripts/builder-worker.ts]]) also runs a per-workspace `sweepStrandedFolds` pass that enqueues via `enqueue_fold` any derived-shipped spec that is stranded outside the queue: `getRoadmap` phase-rollup `shipped` AND not `listArchivedSlugs()` AND no live `build`/`spec-test` job AND no `pending|folding|folded` row AND `getSecurityStateBySlug().completedClean` AND a merged `build` job (`agent_jobs.kind='build'` `status='merged'`). Deliberately **skips the `isCleanMachinePassRun` checks-floor** — a merged build + clean security + all-shipped phases is stronger evidence than any spec-test signal, so a spec whose Verification defines zero machine-runnable checks (a legit clean 0-check run) now folds instead of stranding forever (observed live: `dahlia-researches-from-winners-flow-ad-library`). Idempotent (advisory-lock coalesce + `agent_jobs_one_queued_fold_idx`), best-effort (per-spec + per-workspace `.catch` — a throw never breaks the reaper).

## Indexes / RLS

- `pending_folds_ws_status_idx (workspace_id, status, created_at)`.
- RLS: `pending_folds_select` (workspace members read) · `pending_folds_service` (service role all writes — the box worker).

## Gotchas

- **A fold job's `spec_slug` is the `'fold-batch'` sentinel**, not a real spec — the spec list lives here, not on the job. Don't key the board off the fold job's slug; use `getPendingFolds`.
- **Mid-fold verifies open a second `queued` fold job** (the in-flight one is `building`, so the partial unique index lets a new `queued` one exist). That second job folds the late spec; if both somehow snapshot it, the loser finds it already `folding` and no-ops — never a double fold.

## Migration

`supabase/migrations/20260618160000_fold_batching.sql`

## Related

[[agent_jobs]] · [[../specs/fold-build-batching]] · [[../lifecycles/roadmap-build-console]] · [[../recipes/manage-the-build-queue]] · [[../dashboard/roadmap]]
