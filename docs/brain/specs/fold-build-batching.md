# Fold-build batching + conflict-proof brain indexes ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

Parallel builds collide on **shared index files**. Every "Mark verified & archive" fold-build edits the same top line of `docs/brain/archive.md`, and any build that adds a brain page bumps the `docs/brain/README.md` folder counts — so with the 5-lane worker ([[parallel-builds]] is shipped), a batch of folds/builds all go **`Dirty`** the moment one merges (observed 2026-06-18: 8 fold PRs mutually conflicting, hand-resolution a treadmill). Fix it at three levels so the fleet stays mergeable.

## Phase 1 — Batch fold-builds into one job ✅
- ✅ "Mark verified & archive" ([[../dashboard/roadmap]] `BuildButton`, `POST /api/roadmap/build {verify:true}`) stops spawning one build per spec. Instead it marks the spec **pending-fold** ([[../tables/pending_folds]]) and ensures **one** `kind='fold'` job exists via `enqueue_fold()` (atomic coalesce under a per-workspace advisory lock + a `≤1 queued fold` partial unique index — if one is queued, the spec joins it; if one is mid-flight, the spec rides the next queued batch).
- ✅ The single fold-build (`runFoldJob`) folds **all** currently pending-fold specs in one branch → one `archive.md`/README edit → **one PR**. Far fewer builds, zero inter-fold conflict.

## Phase 2 — Serialize fold-builds (1 lane) ✅
- ✅ `scripts/builder-worker.ts`: per-`kind` concurrency via `claim_agent_job(p_kinds)` — `kind='fold'` runs at **concurrency 1** (`MAX_FOLD`, its own lane), the 5 `MAX_CONCURRENT` lanes stay for `kind='build'`/`'plan'`. A fold never races a feature build on the index files. (Builds on the [[parallel-builds]] pool.)

## Phase 3 — Conflict-proof the index files (durable) ✅
- ✅ **`archive.md` becomes generated.** Each fold writes its entry as a per-spec file `docs/brain/archive.d/{slug}.md`; `archive.md`'s `## Index` is rebuilt from the directory by `scripts/brain-index.mjs` (`npm run brain:index` — the fold-build runs it; doubles as the post-merge reconcile). Two builds never touch the same line.
- ✅ **README folder-counts become generated**, not hand-edited — the same `brain:index` script recomputes each folder's `*.md` count. Builds stop editing the contended count lines.
- ✅ The board's `getArchive()` reads `archive.d/` (falling back to the generated `archive.md`) — no behavior change for [[../dashboard/roadmap]]; `archive.d/**` is file-traced in `next.config.ts`.

## Safety / invariants
- Fold-builds stay **doc-only + low-risk** (fold + `git rm` spec + archive pointer). Serialization + batching only changes *how many* run, not *what* they do.
- Coalescing must be atomic (no double fold job) — reuse `claim_agent_job()` patterns.
- **Coordinates with the planner** ([[goal-decomposition-engine]]) — both touch `builder-worker.ts`/`agent_jobs`; land infra changes serially, not in parallel.

## Completion criteria
- Marking N specs verified produces **one** fold PR, not N.
- Two builds running concurrently never produce a `Dirty` PR from an index-file collision (verified: queue a fold + a feature build together → both merge clean).

## Related
[[parallel-builds]] · [[roadmap-build-console]] · [[../recipes/build-box-setup]] · [[../recipes/manage-the-build-queue]] · [[../dashboard/roadmap]] · [[../project-management]]
