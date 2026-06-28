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

### `enqueuePreMergeSpecTest` — function  *(spec-test-on-preview-pre-merge Phase 1)*

```ts
async function enqueuePreMergeSpecTest(
  workspaceId: string, slug: string, branch: string, previewUrl: string,
): Promise<{ enqueued: boolean; reason?: string }>
```

Sibling of `enqueueSpecTestIfDue` for the **PRE-MERGE** lane. When a `claude/*` build reaches a READY per-build preview (its `preview_url` is set by [[../specs/per-build-vercel-preview-deploys]] Phase 2) and the branch is still unmerged, this enqueues ONE `kind='spec-test'` `agent_jobs` row carrying `spec_branch=branch` (so the runner reads the branch's spec body, not `main`'s) and the **preview origin in `instructions`** (and in `preview_url` when that column is present) — Phase 2 wires the spec-test runner to point its GET / browser checks at the `*.vercel.app` PREVIEW deployment, not prod. Mirrors `enqueueSpecTestIfDue`'s dedupe shape (a `.from('agent_jobs').select('id')` SQL probe + first-hit-wins) but the key is per **(workspace, slug, branch)**: a re-run for the same branch (board refresh, webhook re-fire) no-ops instead of stacking a duplicate row, and a pre-merge run on branch A doesn't block one on branch B (different builds of the same spec). No shipped-but-not-archived gate — pre-merge is by definition not-yet-shipped. The post-ship lane keeps its own (workspace, slug) chokepoint above; the pre-merge dedupe is a STRICTLY-NARROWER key so the two never collide.

### `maybeEnqueuePreMergeSpecTestOnAccumulation` — function  *(spec-goal-branch-pm-flow M3)*

```ts
async function maybeEnqueuePreMergeSpecTestOnAccumulation(args: {
  workspaceId: string; slug: string; branch: string | null; previewUrl: string | null;
}): Promise<{ enqueued: boolean; reason?: string }>
```

The **M3 pre-merge spec-test TRIGGER**. Under the branch-accumulation model a spec's phases build one-by-one onto ONE persistent `claude/build-{slug}` branch (each push fires a per-build Vercel preview — [[preview-capture]]). The spec-test must run ONCE against the WHOLE built spec, not per phase. So the trigger fires iff the spec is **fully accumulated on its branch** ([[specs-table]] `isSpecAccumulationComplete` — every phase carries a `build_sha` / is terminal) AND **a preview URL exists**. The worker calls this from the [[preview-capture]] poll's READY callback (`runBuildJob` in [[../recipes/build-box-setup|builder-worker]]): when the LAST phase's preview goes READY, accumulation is complete → it calls `enqueuePreMergeSpecTest`; earlier phases' previews land READY too but accumulation isn't yet complete → no-op. Idempotent (re-poll / board refresh re-calls; the underlying `enqueuePreMergeSpecTest` dedupes per `(workspace, slug, branch)`). The queued spec-test then materializes the spec from the DB row ([[build-spec-materializer]] reads `public.specs`+`spec_phases`, which M1/M2 stamped from this branch's commits) and points its probes at the preview URL — testing the BUILT spec on its branch preview, not main. Best-effort + never throws.

### `isSpecPromoteEligible` — function  *(spec-goal-branch-pm-flow M3 — the M4 seam)*

```ts
interface SpecPromoteEligibility {
  eligible: boolean; accumulationComplete: boolean; specTestGreen: boolean; securityGreen: boolean; reason: string;
}
async function isSpecPromoteEligible(workspaceId, slug, branch): Promise<SpecPromoteEligibility>
```

The **promote-eligibility signal M4 (spec→goal merge) consumes** — read-only, performs NO action. A branch-flow spec's `claude/build-{slug}` branch is promote-eligible iff ALL THREE hold: **(1) accumulation-complete** (M2 — [[specs-table]] `isSpecAccumulationComplete`), **(2) spec-test green on the branch preview** (M3 — [[spec-test-runs]] `isSpecTestGreenForBranch`, the latest pre-merge `spec_test_runs` row for `(workspace, slug, branch)` is a clean machine pass), **(3) security green on the branch** ([[security-agent]] `isSecurityGreenForBranch` — `completedClean`). These are the SAME three signals the [[github-pr-resolve]] auto-merge gate enforces inline AND the SAME spec-test/security predicates [[brain-roadmap]] `applyInTestingOverlay` derives `in_testing` from — so the board, the auto-merge gate, and this helper can never disagree on "is the spec done testing?". **Fails CLOSED on the green signals** (read error / absent run ⇒ not-green ⇒ not eligible); the accumulation input fails OPEN (a PM-read blip doesn't wedge an otherwise-green spec — the green signals still gate the actual promotion). `reason` explains WHY a spec isn't yet eligible.

### `promoteEligibleSpecsToGoalBranch` — function  *(spec-goal-branch-pm-flow M4 — the spec→goal merge)*

```ts
interface GoalBranchPromoteResult { promoted: string[]; conflicts: string[]; goalBranchesCreated: string[]; skipped: string[]; }
async function promoteEligibleSpecsToGoalBranch(adminClient?): Promise<GoalBranchPromoteResult>
```

The **spec→goal-branch promotion poll** — the M4 integration. For every GOAL-BOUND spec that is `isSpecPromoteEligible` (M3 seam — accumulation ∧ spec-test-green ∧ security-green on its `claude/build-{slug}` branch) and not yet on its goal branch (`goal_branch_sha` unset), it merges that branch into **`goal/{goal-slug}`** (created from `origin/main` by the FIRST spec of the goal — that spec SEEDS it) and stamps `specs.goal_branch_sha` with the merge commit (via [[specs-table]] `stampSpecGoalBranchSha` — the M5 seam). Uses the GitHub `/merges` API ([[github-pr-resolve]] `mergeSpecBranchIntoGoalBranch`) — **no local checkout** — so it runs identically from the box worker standing pass AND the [[../integrations/github]] webhook (mirroring `autoMergeReadyPrs`). **Merges are sequenced by `blocked_by`** (`sequencePromoteCandidates`, a Kahn topo-sort over goal-mate edges) so a dependency lands on the goal branch before its dependent — which then BUILDS off the goal branch (`runBuildJob` Part 2), seeing the dependency's code. ONE merge per spec (idempotent — already-stamped specs skip; the `/merges` 204 path is idempotent). **Does NOT push the goal branch to main** (that's M5's atomic goal→main promotion). **Conflicts are surfaced** (`conflicts[]`), never silently dropped. Best-effort per spec; never throws.

### `resolveGoalSlugForSpec` / `areSpecsGoalMates` — functions  *(spec-goal-branch-pm-flow M4)*

```ts
async function resolveGoalSlugForSpec(workspaceId, slug): Promise<string | null>
async function areSpecsGoalMates(workspaceId, slugA, slugB): Promise<boolean>
```

`resolveGoalSlugForSpec` resolves the GOAL a spec belongs to via `specs.milestone_id → goal_milestones.goal_id → goals.slug` (null = one-off / not goal-bound). `areSpecsGoalMates` = both resolve to the SAME non-null goal slug. The claim-time blocked_by gate ([[../recipes/build-box-setup|builder-worker]] `evaluateClaimTimeBuildGate`) uses these to pick the right blocker-clearance: a **goal-mate** blocker is cleared when ON THE GOAL BRANCH ([[specs-table]] `isSpecOnGoalBranch` — a goal-mate never ships to main until M5's atomic promotion), an **external** blocker (one-off / different goal) is cleared when SHIPPED. This is the load-bearing fix that stops a goal-mate dependent deadlocking forever (its blocker can't ship until the whole goal promotes). The spec-branch base in `runBuildJob` also calls `resolveGoalSlugForSpec` to base a goal-bound fresh spec branch on `origin/goal/{goal-slug}` when that branch exists.

### `reconcileMergedJobs` — function

```ts
async function reconcileMergedJobs(jobs: AgentJob[]): Promise<void>
```

Self-heal: a `completed` job whose PR was merged/closed **outside** the dashboard still shows a stale "Squash & merge" button. Checks GitHub; if the PR is no longer open, flips the job to `merged` (in place + persisted). When a merged (`pr.merged`) `kind='build'` job is flipped, it delegates to **`applyMergedBuildEffects(workspace, slug, { chainPhases, mergeSha })`** — the shared post-merge body. This only fires on the **completed→merged transition**, so a job the auto-merge path already flipped `merged` (via `handleAutoMergedBuildBranch`) is never re-processed here (the two paths never double-run for one merge). Called on board load ([[../dashboard/roadmap]]) and the merge path (`/api/roadmap/build`).

### `applyMergedBuildEffects` — function  *(chain-and-cardstate-under-automerge Phase 1)*

```ts
async function applyMergedBuildEffects(workspaceId, slug, { chainPhases?, mergeSha? }): Promise<void>
```

The shared post-merge body for a merged `kind='build'` job, run identically by **both** paths that flip a build to `merged` — the board-render reconcile (`reconcileMergedJobs`, manual squash-merge) and the auto-merge webhook path (`handleAutoMergedBuildBranch`). **100% DB-driven** ([[../specs/retire-md-reads-from-pm-flow]] Phase 2): reads `public.specs` + `public.spec_phases` via [[specs-table]] `getSpec` — no `spec_card_state` mirror read, no `spec-drift` markdown round-trip. Steps (each best-effort/idempotent): **(1)** TRUST THE MERGE: stamp the phase(s) this merge shipped via `stampPhaseShipped(workspace, slug, position, { pr, merge_sha })` — the build's instructions name `Phase N` (`parsePhaseIndices`), else the first not-yet-shipped position; a one-shot spec (zero phases) records `merged_pr` / `last_merge_sha` on the `specs` row; **(2)** roll up the post-stamp phase set via `rollupPhaseStatus` to compute the new derived status; **(3)** when fully shipped: `enqueueSpecTestIfDue(...,'shipped')` **then** `autoQueueUnblockedBy(...)` (spec-blockers Phase 2); **(4)** every merge: `enqueueSecurityReviewJob` ([[../specs/security-dependency-agent]] Phase 1, deduped by `mergeSha`); **(5)** if `chainPhases`: `queueNextChainedPhase(...)` advances the "Build all" chain off the merge itself, no board render; **(6)** `retestOriginIfFixMerged(...)` (fix-ship-retests-origin) — re-tests the origin spec if `specs.regression_of_slug` links one; **(7)** `enqueueDirectorTopUp(workspace)` ([[../specs/director-initiation-throughput]] Phase 3 — this merge freed a build lane, so trigger a director standing-pass top-up to re-saturate the pool within seconds). Never throws.

### `enqueueDirectorTopUp` — function  *(director-initiation-throughput Phase 3)*

```ts
async function enqueueDirectorTopUp(workspaceId, admin?): Promise<boolean>
```

The **event-driven top-up**. A just-merged build freed a lane → enqueue ONE `platform-director` standing-pass [[agent_jobs]] row so the [[platform-director]] init/groom lanes refill the freed lane **within seconds** instead of waiting up to the (now 5-min, [[../inngest/platform-director-cron]]) cron beat. **Deduped on a PENDING pass** (`status ∈ queued｜queued_resume`): a burst of merges adds at most one waiting pass, but a pass already mid-run still gets a fresh follow-up queued (so it re-saturates after finishing) — two never pile up. Best-effort (never throws); the 5-min cron is the backstop. Called from `applyMergedBuildEffects` (so BOTH merge paths fire it).

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

Closes the propose-fix loop: a just-merged build whose fix spec links back to an origin via the typed `specs.regression_of_slug` column auto-re-tests that **origin** spec, so its stale "Agent-tested · issues" badge clears once the fix is live. **DB-only read** ([[../specs/retire-md-reads-from-pm-flow]] Phase 2 — no more `fetchSpecRawFromMain` + `parseFixesLink` markdown fetch): `getSpec(workspaceId, fixSlug).regression_of_slug` is the provenance. The propose-fix brief (`POST /api/roadmap/chat` `{action:"propose_fix"}` — [[../dashboard/roadmap]]) tells the spec-chat to author the fix with both a `**Regression-of:** [[origin]]` header (which `author-spec.extractRegressionHeaders` lifts into the typed column) and the human-readable `**Fixes:** origin (check key…)` line. Re-enqueues the origin's `spec-test` through the shared `enqueueSpecTestIfDue` guard (no `knownStatus` → the origin's own **shipped-but-not-archived** gate + 20h/in-flight dedupe still apply). **Re-test only** — never marks the origin verified/archived (the owner's gate); a still-failing re-test keeps the red badge correctly. No `regression_of_slug` / self-reference → no-op (back-compatible). Returns the origin slug iff a re-test was enqueued. Called from `applyMergedBuildEffects`.

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
- [[../tables/specs]] + [[../tables/spec_phases]] via [[specs-table]] `getSpec` — the PM-flow reads ([[../specs/retire-md-reads-from-pm-flow]] Phase 2). `docs/brain/archive.d/**` via [[brain-roadmap]] `listArchivedSlugs` for the folded-spec gate.

---

> `applyMergedBuildEffects` also fires the per-diff security pass ([[security-agent]] `enqueueSecurityReviewJob`, deduped by merge SHA) on every merged build — [[../specs/security-dependency-agent]] Phase 1.

[[../README]] · [[brain-roadmap]] · [[spec-drift]] · [[../tables/agent_jobs]] · [[../tables/spec_test_runs]] · [[../inngest/spec-test-cron]] · [[../specs/spec-test-agent]] · [[../specs/spec-test-on-ship]] · [[../lifecycles/roadmap-build-console]] · [[security-agent]]
