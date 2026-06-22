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

Self-heal: a `completed` job whose PR was merged/closed **outside** the dashboard still shows a stale "Squash & merge" button. Checks GitHub; if the PR is no longer open, flips the job to `merged` (in place + persisted). When a merged (`pr.merged`) `kind='build'` job is flipped, it delegates to **`applyMergedBuildEffects(workspace, slug, { chainPhases, mergeSha })`** — the shared post-merge body. This only fires on the **completed→merged transition**, so a job the auto-merge path already flipped `merged` (via `handleAutoMergedBuildBranch`) is never re-processed here (the two paths never double-run for one merge). Called on board load ([[../dashboard/roadmap]]) and the merge path (`/api/roadmap/build`).

### `applyMergedBuildEffects` — function  *(chain-and-cardstate-under-automerge Phase 1)*

```ts
async function applyMergedBuildEffects(workspaceId, slug, { chainPhases?, mergeSha? }): Promise<void>
```

The shared post-merge body for a merged `kind='build'` job, run identically by **both** paths that flip a build to `merged` — the board-render reconcile (`reconcileMergedJobs`, manual squash-merge) and the auto-merge webhook path (`handleAutoMergedBuildBranch`). Steps (each best-effort/idempotent): **(1)** `reconcileSpecDrift(workspace, slug)` ([[spec-drift]]) — per-phase, evidence-gated ✅ flip for phases whose code is verifiably on `main`, returning the post-flip status + `phaseStates` snapshot; **(2)** `markSpecCardMergeShipped(...)` with the status **rolled up from `phaseStates`** (Bug A — a still-⏳ H1 no longer parks a part-shipped card in Planned), tagged `deploy_pending` + this merge's SHA; **(3)** when the spec is now FULLY shipped (`rollupPhaseStatus(phaseStates) === 'shipped'`): `enqueueSpecTestIfDue(...,'shipped')` **then** `autoQueueUnblockedBy(...)` (spec-blockers Phase 2); **(4)** if `chainPhases`: `queueNextChainedPhase(...)` advances the "Build all" chain (Bug B — off the merge itself, no board render); **(5)** `retestOriginIfFixMerged(...)` (fix-ship-retests-origin). Never throws.

### `handleAutoMergedBuildBranch` — function  *(chain-and-cardstate-under-automerge Phase 1)*

```ts
async function handleAutoMergedBuildBranch(branch: string, mergeSha: string | null): Promise<string | null>
```

The auto-merge path's post-merge hook. When the GitHub webhook's auto-merge gate ([[github-pr-resolve]] `autoMergeReadyPrs`, [[../specs/auto-ship-pipeline]]) squash-merges a `claude/*` build PR **server-side**, this advances the same post-merge state a board render would — **without waiting for one**. Maps the merged branch → its newest `kind='build'` job, flips it `merged`, and runs `applyMergedBuildEffects`. This is what makes "Build all" hands-off under auto-merge: P1 auto-merges → P2 auto-queues inside the webhook window, no click, no board load. **Idempotent:** a job already `merged` is skipped (and because `reconcileMergedJobs` only acts on `completed` jobs, flipping it here keeps that path from double-firing; every effect inside is deduped besides). Best-effort — returns the advanced slug or null. Called from `autoMergeReadyPrs` right after a successful squash-merge.

### `queueNextChainedPhase` — function  *(build-all-phases-chain Phase 1)*

```ts
async function queueNextChainedPhase(workspaceId: string, slug: string): Promise<string | null>
```

Advance a **"Build all" chain**. A `chain_phases` build for `slug` just merged (its phase landed on `main` + flipped ✅); this reads the spec from `main` (`getSpec`), finds the **next ⏳ phase**, and queues it as a fresh `queued` `kind='build'` row — also `chain_phases:true`, scoped to that phase (`phaseScopedInstructions`), built on fresh `main` atop the prior phase's code. The chain runs hands-off: each phase builds → auto-merges ([[../specs/auto-ship-pipeline]]) → queues the next, until no ⏳ phase remains (every phase ✅ = chain complete → null). **Stops/pauses for free:** a phase that **fails** or hits **needs_approval** never reaches `merged`, so this is never called for it (chain stops/pauses; resuming + merging the phase resumes the chain). **De-duped:** skips when any build job for the spec is already in flight (`status` ∈ ACTIVE_STATUSES) — `reconcileMergedJobs` flips a job completed→merged once so this normally fires once per phase; the guard covers concurrent board loads. Returns the queued phase title, or null. Best-effort. Called from `applyMergedBuildEffects` (the shared post-merge body run by both the board-render reconcile and the auto-merge path).

### `phaseScopedInstructions` — function  *(build-all-phases-chain Phase 1)*

```ts
function phaseScopedInstructions(phaseTitle: string): string
```

The build instruction scoping a build to ONE phase (`Implement ONLY this phase of the spec: "…". Mark that phase's emoji ✅ when done. Do not modify other phases.`) — shared by the dashboard per-phase Build, the "Build all" first-phase queue ([[roadmap-actions]] `queueRoadmapBuild`), and `queueNextChainedPhase`, so all three drive the box identically.

### `retestOriginIfFixMerged` — function  *(fix-ship-retests-origin)*

```ts
async function retestOriginIfFixMerged(workspaceId: string, fixSlug: string): Promise<string | null>
```

Closes the propose-fix loop: a just-merged build whose spec carries a machine-readable `**Fixes:** {origin} (check {key}…)` line (stamped by `POST /api/roadmap/chat` `{action:"propose_fix"}` — [[../dashboard/roadmap]]) auto-re-tests the **origin** spec, so the origin's stale "Agent-tested · issues" badge clears once the fix is live. Reads the merged fix spec from `main` (`fetchSpecRawFromMain`), parses the link (`parseFixesLink` — both [[spec-drift]]), and re-enqueues the origin's `spec-test` through the shared `enqueueSpecTestIfDue` guard (no `knownStatus` → the origin's own **shipped-but-not-archived** gate + 20h/in-flight dedupe still apply). **Re-test only** — never marks the origin verified/archived (the owner's gate); a still-failing re-test keeps the red badge correctly. No `Fixes:` link / self-reference → no-op (back-compatible). Returns the origin slug iff a re-test was enqueued. Called from `applyMergedBuildEffects`.

### `autoQueueUnblockedBy` — function  *(spec-blockers Phase 2)*

```ts
async function autoQueueUnblockedBy(workspaceId: string, shippedSlug: string): Promise<string[]>
```

Auto-queue on unblock. `shippedSlug` just shipped (its build PR merged + phases flipped ✅); this finds every **live** spec (via `getRoadmap`) that named it in `**Blocked-by:**` and, if that was its **last** uncleared blocker (`blockedBy.every(b => b.cleared || b.slug === shippedSlug)` — `shippedSlug` is treated as cleared so a deploy-stale disk snapshot of its status can't suppress the unblock), inserts a `queued` `kind='build'` row (`created_by=null`, instructions naming the prerequisite). The chain goes hands-off: merge the prerequisite, the dependent build fires itself. **Skips** a dependent that already has ANY `build` job (dedupe — *one auto-queue per spec*, so calling this on every board load no-ops), is itself `shipped`, or opted out via `**Auto-build:** off` (`SpecCard.autoBuild === false`). Returns the slugs queued. Called from `applyMergedBuildEffects` (on the shipped transition).

### `findMergedSiblingBuild` — function  *(dirty-pr-resolver-duplicate-detection)*

```ts
async function findMergedSiblingBuild(
  workspaceId: string, slug: string,
  opts?: { excludeJobId?: string; excludeBranch?: string | null; instructions?: string | null; admin?: Admin },
): Promise<{ id: string; spec_branch: string | null; pr_number: number | null } | null>
```

The shared "is this spec's build already merged?" probe ([[../specs/dirty-pr-resolver-duplicate-detection]] Phase 1). A build flips to `status='merged'` once `reconcileMergedJobs` sees its PR merged (the work landed on `main`); this finds a **sibling** build of the same spec that already merged — the signal that a second still-open/conflicting build is a **duplicate** (its diff is already on `main`, so it can never resolve and re-running it just re-ships). **Phase-scope safe:** with an `instructions` filter it matches only a merged build doing the *same* work, so a multi-phase chain (phase-1 merged, phase-2 building — different `phaseScopedInstructions`) is not mistaken for a dup. `excludeJobId`/`excludeBranch` ignore the job/branch being checked. Three callers dedupe on it: the box worker's **build-claim** (no-op a build whose work already shipped), `runPrResolveJob` + `detectAndEnqueueDirtyPrs` (via `findAlreadyMergedDuplicate` in [[github-pr-resolve]] — close the duplicate PR instead of resolving), and `scripts/requeue-failed-builds.ts` (skip re-queueing an already-merged failed build).

### `getLiveJobForSlug` / `cancelJobsForArchivedSpecs` — functions  *(fold-guard-live-build)*

```ts
async function getLiveJobForSlug(workspaceId, slug, admin?): Promise<AgentJob | null>
async function cancelJobsForArchivedSpecs(opts?: { workspaceId?; admin? }): Promise<{ cancelled: number; slugs: string[] }>
```

The two guards that stop a fold from **orphaning a live build**. A fold moves the spec markdown to `docs/brain/archive.d/`, so the instant the fold merges a still-running build's spec page **404s** — the paused/active card becomes a dead link and answering it is meaningless (observed live 2026-06-22: `control-tower-escalation-idle-grace` folded + archived while a `needs_input` build for it was alive). Only `build`/`spec-test` kinds count as "a live build of THIS spec" — a `fold` job carries `spec_slug='fold-batch'` and a `plan` job keys on a goal slug, so neither matches.

- **`getLiveJobForSlug`** (preventive) — newest non-terminal (`ACTIVE_STATUSES`) `build`/`spec-test` job for `(workspaceId, slug)`, else null. The fold path **refuses to fold while it returns a row**: the manual verify→fold in `queueRoadmapBuild` ([[roadmap-actions]]) returns `409 "Can't archive — a {kind} build for this spec is still live ({status}). It'll fold once that build finishes."`, and the auto-fold gate `getAutoFoldEligibleSlugs` ([[spec-test-runs]], [[../specs/auto-ship-pipeline]] Gate B) **omits** the slug — so the two can never disagree. The build completing re-triggers the gate, so the fold is **deferred, never dropped**.
- **`cancelJobsForArchivedSpecs`** (cleanup backstop) — for every non-terminal `build`/`spec-test` job whose `spec_slug` is in `archive.d/` (`listArchivedSlugs`), flips it `status='completed'` `error='spec archived — build auto-cancelled …'` and clears `questions`/`pending_actions`, so no dead-link card survives a fold that raced a build. Global by default (archive.d/ is global); `workspaceId` scopes it. Idempotent (terminal jobs untouched), best-effort (one failed update never aborts the rest). Wired into **two spots**: the box worker's `reapArchivedSpecJobs` at startup ([[../recipes/build-box-setup]] § Startup orphan-reaper) and the `kind='fold'` merge reconcile (board load after a fold PR merges).

### Read helpers

- `getLatestPlanJob(workspaceId, goalSlug)` — newest `plan` job for a goal (drives Plan/Re-plan).
- `getLatestJobsBySlug(workspaceId)` — latest job per spec (board per-card status).
- `getPendingFolds(workspaceId)` — specs queued for / mid- a fold-build ([[../specs/fold-build-batching]]).

## Tables written

- [[../tables/agent_jobs]] (inserts `spec-test` rows via `enqueueSpecTestIfDue`; inserts auto-queued `build` rows via `autoQueueUnblockedBy` — [[../specs/spec-blockers]]; flips jobs → `merged` in `reconcileMergedJobs`)

## Tables read (not written)

- [[../tables/agent_jobs]] (in-flight dedupe, latest-job/plan lookups), [[../tables/spec_test_runs]] (fresh-run dedupe), [[../tables/pending_folds]]
- `docs/brain/specs/**` + `docs/brain/archive.d/**` via [[brain-roadmap]] (`getSpec` / `listArchivedSlugs` / `deriveSpecStatus`) — and GitHub `contents` (via [[spec-drift]] `reconcileSpecDrift` on the merge path)

---

[[../README]] · [[brain-roadmap]] · [[spec-drift]] · [[../tables/agent_jobs]] · [[../tables/spec_test_runs]] · [[../inngest/spec-test-cron]] · [[../specs/spec-test-agent]] · [[../specs/spec-test-on-ship]] · [[../lifecycles/roadmap-build-console]]
