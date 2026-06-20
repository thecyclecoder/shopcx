# libraries/agent-jobs

Server-side helpers over the [[../tables/agent_jobs]] build queue — the dashboard "Build" button inserts a row; the box worker claims it via `claim_agent_job()` and drives it to a PR. Also home to the **shared spec-test enqueue guard** ([[../specs/spec-test-on-ship]]). See [[../lifecycles/roadmap-build-console]].

**File:** `src/lib/agent-jobs.ts`

## Types

- `JobStatus` — `queued｜claimed｜building｜needs_input｜needs_approval｜queued_resume｜completed｜merged｜failed｜needs_attention`. `ACTIVE_STATUSES` / `isActive()` classify the live ones.
- `JobKind` — `build｜plan｜fold｜product-seed｜ticket-improve` (the box also runs `spec-test` jobs, inserted by `enqueueSpecTestIfDue` + the cron).
- `AgentJob`, `PendingAction` / `GatedActionType` / `ProposedSpec` (planner branch proposals), `PendingFold`.

## Exports

### `enqueueSpecTestIfDue` — function  *(spec-test-on-ship)*

```ts
async function enqueueSpecTestIfDue(
  workspaceId: string, slug: string, knownStatus?: Phase,
): Promise<{ enqueued: boolean; reason?: string }>
```

The **single dedupe chokepoint** shared by all three spec-test enqueue paths: the daily backlog cron ([[../inngest/spec-test-cron]]), the manual status flip (`POST /api/roadmap/status`), and the build-merge reconcile (`reconcileMergedJobs`). Inserts one `queued` `agent_jobs` row `kind='spec-test'` for `(workspaceId, slug)` **iff** the spec is **shipped-but-not-archived** AND not already covered — **no in-flight** spec-test job (`status` ∈ `queued｜queued_resume｜building｜claimed`) **and no fresh** [[../tables/spec_test_runs]] row (last ~20h). First caller wins; the rest no-op. Re-running is allowed once the spec changes again (a fresh ship state past the window).

- `knownStatus` — when a caller already holds the freshly-derived status, pass it to skip a disk re-read of the spec (the cron passes `'shipped'`; the status route passes `deriveSpecStatus(updated)` over the just-committed content, since the deployed bundle's local disk is stale vs. that commit). Omit it to derive **shipped-but-not-archived** from disk (`getSpec` + `listArchivedSlugs`, [[brain-roadmap]]).

### `reconcileMergedJobs` — function

```ts
async function reconcileMergedJobs(jobs: AgentJob[]): Promise<void>
```

Self-heal: a `completed` job whose PR was merged/closed **outside** the dashboard still shows a stale "Squash & merge" button. Checks GitHub; if the PR is no longer open, flips the job to `merged` (in place + persisted). **spec-test-on-ship:** when a merged (`pr.merged`) `kind='build'` job is flipped, it fetches the spec from `main` (`fetchSpecFromMain`, independent of the possibly-stale local bundle) and, if `deriveSpecStatus` is now `shipped`, calls `enqueueSpecTestIfDue(...,'shipped')`. Called on board load ([[../dashboard/roadmap]]) and the merge path (`/api/roadmap/build`).

### Read helpers

- `getLatestPlanJob(workspaceId, goalSlug)` — newest `plan` job for a goal (drives Plan/Re-plan).
- `getLatestJobsBySlug(workspaceId)` — latest job per spec (board per-card status).
- `getPendingFolds(workspaceId)` — specs queued for / mid- a fold-build ([[../specs/fold-build-batching]]).

## Tables written

- [[../tables/agent_jobs]] (inserts `spec-test` rows via `enqueueSpecTestIfDue`; flips jobs → `merged` in `reconcileMergedJobs`)

## Tables read (not written)

- [[../tables/agent_jobs]] (in-flight dedupe, latest-job/plan lookups), [[../tables/spec_test_runs]] (fresh-run dedupe), [[../tables/pending_folds]]
- `docs/brain/specs/**` + `docs/brain/archive.d/**` via [[brain-roadmap]] (`getSpec` / `listArchivedSlugs` / `deriveSpecStatus`) — and GitHub `contents` for `fetchSpecFromMain`

---

[[../README]] · [[brain-roadmap]] · [[../tables/agent_jobs]] · [[../tables/spec_test_runs]] · [[../inngest/spec-test-cron]] · [[../specs/spec-test-agent]] · [[../specs/spec-test-on-ship]] · [[../lifecycles/roadmap-build-console]]
