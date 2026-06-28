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

The **M3 pre-merge spec-test TRIGGER**. Under the branch-accumulation model a spec's phases build one-by-one onto ONE persistent `claude/build-{slug}` branch (each push fires a per-build Vercel preview — [[preview-capture]]). The spec-test must run ONCE against the WHOLE built spec, not per phase. So the trigger fires iff the spec is **fully accumulated on its branch** ([[specs-table]] `isSpecAccumulationComplete` — every phase carries a `build_sha` / is terminal) AND **a preview URL exists**. The worker calls this from THREE places (idempotent — the underlying `enqueuePreMergeSpecTest` dedupes per `(workspace, slug, branch)`):
1. The [[preview-capture]] poll's READY callback on the **success-push** path (`runBuildJob` in [[../recipes/build-box-setup|builder-worker]]): when the LAST phase's preview goes READY after a push, accumulation is complete → enqueue; earlier phases' previews land READY too but accumulation isn't yet complete → no-op.
2. **`finalizeBuiltPhase` at accumulation-complete** (the resume-after-approval fix): a `needs_approval` phase commits its WIP DURING the pause and the approved resume only applies the migration (no new edits → the `!dirty` branch → `finalizeBuiltPhase`), so the success-push poll callback NEVER runs for the accumulation-completing phase and the branch tip doesn't change at finalize (so the prior phase's poll doesn't re-fire). Result pre-fix: a fully-accumulated PR (`noop-pipeline-test-4` / #837) sat `in_testing` forever, `spec_test_runs` EMPTY, no branch-mode security review — the M4 tests gate could never go green. The fix: right after `ensurePr` opens the real PR, `finalizeBuiltPhase` fires a fire-and-forget `pollCapturePreviewUrl` onto THIS job row and (on READY) calls both pre-merge triggers.
3. **`backstopPreMergeChecks`** — the standing-pass heartbeat (below), which also recovers the case where no preview was ever captured.

The queued spec-test then materializes the spec from the DB row ([[build-spec-materializer]] reads `public.specs`+`spec_phases`, which M1/M2 stamped from this branch's commits) and points its probes at the preview URL — testing the BUILT spec on its branch preview, not main. Best-effort + never throws.

### `maybeEnqueuePreMergeSecurityOnAccumulation` — function  *(security-test-on-preview-pre-merge Phase 1 — the wiring)*

```ts
async function maybeEnqueuePreMergeSecurityOnAccumulation(args: {
  workspaceId: string; slug: string; branch: string | null; previewUrl: string | null; prNumber?: number | null;
}): Promise<{ enqueued: boolean; reason?: string }>
```

The **pre-merge SECURITY TRIGGER** — the security twin of `maybeEnqueuePreMergeSpecTestOnAccumulation`. Same accumulation predicate (test the WHOLE built spec on its branch preview); calls [[security-agent]] `enqueueSecurityReviewJob` in `branch` mode. **This is the caller the `security-test-on-preview-pre-merge` spec said the preview-ready hook would invoke but never landed** — until it was wired, the branch-mode enqueue had ZERO callers, so [[security-agent]] `isSecurityGreenForBranch` was ALWAYS false and the M4 tests gate (`isSpecPromoteEligible` ∧ `autoMergeReadyPrs`) could never pass (every one-off PR sat `in_testing`; branch-mode reviews = 0 in prod). Invoked from `runBuildJob`'s preview-ready callback alongside the spec-test trigger, AND from `backstopPreMergeChecks`. Idempotent (one open review per branch). Best-effort + never throws.

### `backstopPreMergeChecks` — function  *(Gate-A class gap fix — standing-pass backstop)*

```ts
async function backstopPreMergeChecks(adminClient?): Promise<PreMergeBackstopResult>
```

The **standing-pass backstop for BOTH pre-merge triggers** (spec-test + security). Both enqueues fire only from the build's fire-and-forget preview-capture READY callback — the SAME event-only gap Gate-A had: a missed READY (worker restart, slow preview, transient hiccup) means the signal is never enqueued and the branch stalls `in_testing` forever. This re-evaluates every READY-preview `claude/build-*` build job (latest per slug) each platform-director standing pass and (idempotently) re-fires `maybeEnqueuePreMergeSpecTestOnAccumulation` + `maybeEnqueuePreMergeSecurityOnAccumulation`. The underlying enqueues dedupe, so running it every pass is safe + cheap. Best-effort per branch; never throws.

**No-captured-preview recovery (resume-after-approval fix — `noop-pipeline-test-4` / #837).** The original backstop scanned only branches whose build row already carries a **READY** preview — but the resume-after-approval finalize path never captures the branch tip's preview (the `commitWip` push at the `needs_approval` pause pushes the branch but kicks no `pollCapturePreviewUrl`, and the resume's `!dirty` finalize pushes nothing). So #837's latest build row had `preview_state` null and the READY-only scan skipped it forever → permanent `in_testing` with EMPTY `spec_test_runs`. The backstop now adds an **on-demand capture** for the latest build row of an in-flight spec whose preview isn't READY, gated tight to avoid hammering Vercel: only when the spec is **fully accumulated** (`isSpecAccumulationComplete`), has an **open PR** (`pr_url`/`pr_number`), and has **NO `spec_test_runs` row for `(workspace, slug, branch)` yet**. It calls `capturePreviewUrlForJob({ jobId, branch, commitSha: null })` to persist the branch tip's preview onto that row, then falls through to the normal spec-test + security triggers. Idempotent (`capturePreviewUrlForJob` only advances the row forward; once a run exists the recovery short-circuits). This is the heartbeat that self-recovers any spec stuck the way #837 was.

**In-flight-only filter (vault-security-review-loop-fix + post-merge backstop loop fix).** The backstop SKIPS any branch whose spec is no longer in-flight — checked BEFORE both the READY-scan and the no-preview recovery. Three skip signals, in order: **(a)** spec **archived** (slug in `listArchivedSlugs`); **(b)** the spec's PR is **MERGED** — the latest `build` job for the slug is `status='merged'` OR `findMergedSiblingBuild` finds a merged sibling (the `claude/build-*` branch is DELETED, so a pre-merge review would "review an unmerged branch" that no longer exists, burning a Max session every pass); **(c)** spec **shipped/folded** (DB `specs.status` via `getSpec`). Why (b) is needed on top of (c): the post-merge-ships-only-one-phase bug left a MERGED spec reading `in_progress`/`planned` (only one phase stamped), so the `shipped/folded` check never fired and the security loop ran forever (`noop-pipeline-test-4` / #837 — `pre-merge backstop → security 1 (re-)enqueued` + `[security] reviewing unmerged branch …` every pass for the deleted branch). The merge-signal skip stops it regardless of the stuck status. Pre-merge gating is an in-flight-only concern: once a spec has merged or folded, re-running spec-test/security on its stale READY-preview branch is pure waste. This was also half of the **Vault re-review loop** (a folded spec's stale READY branch got a fresh `security-review` each pass forever — `spec-test-request-fix-inline-author-and-approve`, `in-testing-board-and-lifecycle-timeline`). The dedup half is fixed in [[security-agent]] `enqueueSecurityReviewJob` branch mode (a MERGED branch is refused outright, and a CLEAN review blocks re-enqueue until a genuine new build push — not a status-only `updated_at` bump). Net: a merged/shipped/folded spec gets NO new security-review; an in-flight branch gets exactly ONE per branch state.

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

### `promoteCompleteGoalsToMain` — function  *(spec-goal-branch-pm-flow M5 — the ATOMIC goal→main promotion)*

```ts
interface GoalPromotionEffects { stampedSpecs: string[]; phasesStamped: number; foldsTriggered: string[]; }
interface PromoteGoalsToMainResult { promoted: string[]; conflicts: string[]; parentExempt: string[]; notReady: string[]; effects: Record<string, GoalPromotionEffects>; }
async function promoteCompleteGoalsToMain(adminClient?): Promise<PromoteGoalsToMainResult>
```

The **atomic goal→main promotion poll** — M5, one hop past M4. For every GREENLIT (non-`proposed`/non-`folded`) goal in the build-console workspace it gates in order: **(1) parent-goal exemption** — skip a parent via [[goals-table]] `isGoalParentExempt` (`is_parent` flag OR has child goals OR no buildable specs — a parent has no goal branch; its children promote independently); **(2) goal-complete** — require [[specs-table]] `goalBranchState(goalSlug).allOnGoalBranch` (every member spec integrated on the goal branch — M4's seam); **(3) GREEN** (option b, combination-verified without extra preview deploys) — require EVERY member spec individually `isSpecPromoteEligible` on its own branch (accumulation ∧ spec-test-green ∧ security-green — already tested), and the atomic merge itself is the final combination check (each dependent built OFF the goal branch, so the integrated whole was compiled together; a clean land confirms no `main` drift); **(4) promote** — [[github-pr-resolve]] `mergeGoalBranchIntoMain(goalSlug)` merges `goal/{slug}` → main in ONE merge, then `applyGoalPromotionEffects(workspace, goalSlug, mergeSha)` stamps shipped. A **409 conflict** HOLDS the goal (`conflicts[]`, nothing stamped). Runs from the SAME seams M4 uses (box worker standing pass + the Gate-C github webhook); GitHub `/merges` API (no checkout). Idempotent (a goal already on main merges as a 204 + re-stamps inertly), best-effort per goal, never throws. **One-off (no-goal) specs do NOT promote here** — they ship via the Gate A auto-merge of their `claude/build-{slug}` branch (see `applyMergedBuildEffects` whole-spec stamping below).

### `applyGoalPromotionEffects` — function  *(spec-goal-branch-pm-flow M5 — the ONLY shipped-writer)*

```ts
async function applyGoalPromotionEffects(workspaceId, goalSlug, mergeSha): Promise<GoalPromotionEffects>
```

The **promotion EFFECTS of an atomic goal→main merge**: flip EVERY phase of EVERY member spec of `goalSlug` to `shipped`, tagged with `merge_sha = mergeSha` (the main merge commit), then trigger the fold pipeline. This is the **only shipped-writer in the branch-flow** (M2–M4 reserved `status='shipped'` + `merge_sha` for exactly here — `build_sha`'d / `in_progress` phases stay `in_progress` until this moment). Reuses [[specs-table]] `stampPhaseShipped` per phase (SDK-only — no raw PM SQL); a phase already `shipped`/`rejected` is left as-is (idempotent); a one-shot spec (zero phases) records card-level `merged_pr`/`last_merge_sha` via `stampSpecMergeProvenance`. After stamping, the read-time rollup derives each spec `shipped` and the goal `complete`. Then, mirroring `applyMergedBuildEffects`' post-ship hook, it calls `enqueueSpecTestIfDue(ws, slug, 'shipped')` per shipped spec (the fold-pipeline entry — spec-test against the on-main code → fold gate archives it) **and** `autoQueueUnblockedBy` (release dependents). Best-effort per spec.

### `reconcileMergedJobs` — function

```ts
async function reconcileMergedJobs(jobs: AgentJob[]): Promise<void>
```

Self-heal: a `completed` job whose PR was merged/closed **outside** the dashboard still shows a stale "Squash & merge" button. Checks GitHub; if the PR is no longer open, flips the job to `merged` (in place + persisted). When a merged (`pr.merged`) `kind='build'` job is flipped, it delegates to **`applyMergedBuildEffects(workspace, slug, { chainPhases, mergeSha })`** — the shared post-merge body. This only fires on the **completed→merged transition**, so a job the auto-merge path already flipped `merged` (via `handleAutoMergedBuildBranch`) is never re-processed here (the two paths never double-run for one merge). Called on board load ([[../dashboard/roadmap]]) and the merge path (`/api/roadmap/build`).

### `applyMergedBuildEffects` — function  *(chain-and-cardstate-under-automerge Phase 1)*

```ts
async function applyMergedBuildEffects(workspaceId, slug, { chainPhases?, mergeSha? }): Promise<void>
```

The shared post-merge body for a merged `kind='build'` job, run identically by **both** paths that flip a build to `merged` — the board-render reconcile (`reconcileMergedJobs`, manual squash-merge) and the auto-merge webhook path (`handleAutoMergedBuildBranch`). **100% DB-driven** ([[../specs/retire-md-reads-from-pm-flow]] Phase 2): reads `public.specs` + `public.spec_phases` via [[specs-table]] `getSpec` — no `spec_card_state` mirror read, no `spec-drift` markdown round-trip. Steps (each best-effort/idempotent): **(1)** TRUST THE MERGE: stamp the phase(s) this merge shipped via `stampPhaseShipped(workspace, slug, position, { pr, merge_sha })`. Phase selection (**ship-all-phases-on-squash-merge** — the post-merge-ships-only-one-phase fix): **accumulation-complete now wins FIRST** — a squash-merge collapses the WHOLE accumulated `claude/build-{slug}` branch into one commit on main, so when `isSpecAccumulationComplete` is true (the M2 gate only ever merges a fully-built branch) stamp **EVERY** non-terminal phase shipped, *regardless of which phase the build's `instructions` name*. (The old order checked the named-phase shortcut first, so a director-initiated / chain build whose `instructions` said "Phase 2" stamped ONLY P2 and left P1 `in_progress` forever — `noop-pipeline-test-4` / #837.) **Fallbacks** when NOT fully accumulated (the now-rare partial merge): the instructions name `Phase N` (`parsePhaseIndices`) → those positions; else advance the first not-yet-shipped phase. A single-phase spec advances its one phase; a one-shot spec (zero phases) records `merged_pr` / `last_merge_sha` on the `specs` row. This is how a one-off promote-eligible spec ships ALL its phases on its single auto-merge to main; **(2)** roll up the post-stamp phase set via `rollupPhaseStatus` to compute the new derived status; **(3)** when fully shipped: `enqueueSpecTestIfDue(...,'shipped')` **then** `autoQueueUnblockedBy(...)` (spec-blockers Phase 2); **(4)** every merge: `enqueueSecurityReviewJob` ([[../specs/security-dependency-agent]] Phase 1, deduped by `mergeSha`); **(5)** if `chainPhases`: `queueNextChainedPhase(...)` advances the "Build all" chain off the merge itself, no board render; **(6)** `retestOriginIfFixMerged(...)` (fix-ship-retests-origin) — re-tests the origin spec if `specs.regression_of_slug` links one; **(7)** `enqueueDirectorTopUp(workspace)` ([[../specs/director-initiation-throughput]] Phase 3 — this merge freed a build lane, so trigger a director standing-pass top-up to re-saturate the pool within seconds). Never throws.

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

### `reconcileMergedSpecPhases` — function  *(ship-all-phases-on-squash-merge — standing-pass recovery)*

```ts
async function reconcileMergedSpecPhases(admin?): Promise<{ reconciled: string[]; phasesStamped: number }>
```

The **re-runnable recovery** for the post-merge-ships-only-one-phase bug. `applyMergedBuildEffects` now stamps EVERY phase of a fully-accumulated squash-merge — but it only runs on the **completed→merged transition**, so a spec that ALREADY merged under the old (one-phase-only) hook is STUCK with un-shipped phases (`noop-pipeline-test-4` / #837: P1 `in_progress`, `merge_sha=NULL`, while P2 shipped). This standing-pass function recovers them: it enumerates `merged` `kind='build'` jobs (one per slug), and for any whose spec still has a NON-terminal phase, stamps each remaining phase `shipped` with the **merge SHA recovered from an already-shipped sibling phase** (the squash-merge commit) + that phase's `pr`. If NO phase is shipped yet (no SHA to copy) it LEAVES the spec for the audit path (`audit-spec-shipped-state`) — never blanket-ships without provenance. After back-fill it fires the post-ship hooks (`enqueueSpecTestIfDue('shipped')` + `autoQueueUnblockedBy`). **Strictly idempotent** — a fully-shipped spec is skipped, and `stampPhaseShipped` on an already-shipped phase is inert. Called from the [[../../../scripts/builder-worker]] platform-director **standing pass** (right after the Gate-A auto-merge backstop). Best-effort per spec; never throws.

### `queueNextChainedPhase` — function  *(build-all-phases-chain Phase 1)*

```ts
async function queueNextChainedPhase(workspaceId: string, slug: string): Promise<string | null>
```

Advance the phase chain. Reads the spec **in the passed `workspaceId`** (`getSpec(slug, workspaceId)` — load-bearing: a spec in a non-default workspace would otherwise resolve the WRONG workspace and find no phases), finds the **next ⏳ phase** (the first `planned` phase — a built phase carries `build_sha` and reads `in_progress`, so it's skipped), and queues it as a fresh `queued` `kind='build'` row — `chain_phases:true`, scoped to that phase (`phaseScopedInstructions`). Returns the queued phase title, or null (no `planned` phase remains → chain complete). **De-duped:** skips when a build job already carries that phase's scoped instructions, OR any build job for the spec is in flight (`status` ∈ ACTIVE_STATUSES). Best-effort.

**Two callers — branch-build is now the primary one (E3 fix — `chain-on-every-branch-build`):**

1. **`runBuildJob` post-branch-build** (the live driver under M1's branch-accumulation flow). After a phase BUILDS on `claude/build-{slug}` (`stampPhaseBuilt` set its `build_sha`), the worker calls this to queue phase N+1 onto the SAME branch tip (create-or-extend checks out the existing branch). **This fires for EVERY multi-phase spec build — NOT gated on `chain_phases`.** Under branch-accumulation no per-phase main merge ever happens, so the merge-hook chain (below) never fires per phase; AND every build is now scoped to one phase (`one-phase-per-session`), so a director-initiated / single build of a multi-phase spec builds only phase 1 and **must** chain phase 2 itself — otherwise the branch never accumulates the rest of the spec and promotion (needs accumulation-complete) can never fire. *(The bug this closes — `noop-pipeline-test-1`: P1 built with `chain_phases=false` → P2 never queued → spec wedged. Earlier the call was gated on `job.chain_phases`, and `queueNextChainedPhase` read the default workspace; both are fixed.)*

2. **`applyMergedBuildEffects` (legacy merge-hook path)** — still calls it when `chainPhases` on a real main merge, for any legacy per-phase-merge flow; inert under branch-flow (no per-phase merge fires). Best-effort.

**Stops/pauses for free:** a phase that **fails** or hits **needs_approval** never reaches `completed`, so this is never called for it (chain stops/pauses; resuming the phase resumes the chain).

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
