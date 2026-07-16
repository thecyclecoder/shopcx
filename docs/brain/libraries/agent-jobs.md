# libraries/agent-jobs

Server-side helpers over the [[../tables/agent_jobs]] build queue — the dashboard "Build" button inserts a row; the box worker claims it via `claim_agent_job()` and drives it to a PR. Also home to the **shared spec-test enqueue guard** ([[../specs/spec-test-on-ship]]). See [[../lifecycles/roadmap-build-console]]. The `enqueueXIfDue` helpers in this file (`enqueueSpecTestIfDue` + `enqueuePreMergeSpecTest` below) are the canonical shape referenced by the [[../operational-rules#PM-agent activation contract|PM-agent activation contract]] — pending-pool predicate + one-in-flight guard behind a legible `{ enqueued, reason }`; every reactive fire, cron, and standing-pass backstop routes through the same chokepoint.

**File:** `src/lib/agent-jobs.ts`

## Types

- `JobStatus` — `queued｜claimed｜building｜needs_input｜needs_approval｜queued_resume｜completed｜merged｜failed｜needs_attention`. `ACTIVE_STATUSES` / `isActive()` classify the live ones.
- `JobKind` — `build｜plan｜fold｜product-seed｜ticket-improve` (the box also runs `spec-test` jobs, inserted by `enqueueSpecTestIfDue` + the cron).
- `AgentJob`, `PendingAction` / `GatedActionType` / `ProposedSpec` (planner branch proposals), `PendingFold`.

## Exports

### `enqueueBuildIfDue` — function  *(bo-reactive-gated-build-enqueue Phase 1)*

```ts
async function enqueueBuildIfDue(
  workspaceId: string, slug: string,
  opts?: { createdBy?: string | null; instructions?: string | null },
): Promise<{ enqueued: boolean; reason?: string; jobId?: string }>
```

The **single gated chokepoint** for inserting a `kind='build'` [[../tables/agent_jobs]] row for a spec — parallel of Vale's `enqueueSpecReviewIfDue` ([[../specs/vale-reactive-spec-review]], src/lib/agents/spec-review.ts) and Bo's shipped-lane `enqueueSpecTestIfDue` (above). One cheap `getSpec` read + one **BUILD-ELIGIBILITY gate** matching Ada's `isBuildableSpec` predicate ([[platform-director]] `specReviewDone` + not deferred + not shipped + `auto_build!==false` + all `blocked_by` cleared) + a **one-in-flight guard** (no existing `kind='build'` job for `(workspace, slug)` in `queued/queued_resume/building/claimed`). Idempotent — a duplicate call no-ops instead of stacking.

Every reactive/agent-driven enqueue path routes through here so Bo never gets a `queued` row for an un-Vale-passed / un-dispositioned / deferred / blocked spec — closing the CEO-visible bug where the reactive `autoQueueUnblockedBy` inserted a build row for an unblocked-but-unreviewed dependent, which the claim-gate then held indefinitely (the "premature row on the board" symptom). Distinct `reason` values so a cron/heartbeat log stays legible: `spec-not-found｜already-shipped｜deferred｜in-review-pending-disposition｜not-review-passed｜auto-build-off｜blocked｜in-flight`.

**`in_review` gate ([[../specs/fix-bo-reactive-gated-build-enqueue-a3f2e4]]).** `in_review` is the ONE lifecycle state where Vale has (or may have) already passed but Ada hasn't yet dispositioned the spec (`planned` vs `deferred`) — a spec-review-agent-authored spec (or Vale-passed refine) stays `in_review` between Vale's pass write and Ada's disposition sweep. The Phase-2 reactive event fires from `markSpecCardValePassed` the moment `valeReviewPassed` flips true — but without the `in_review` gate, `enqueueBuildIfDue` would enqueue a build BEFORE Ada dispositions the spec, contradicting the "Vale reviews → Ada disposes → THEN build" flow the [[../specs/vale-reactive-spec-review]] + [[../specs/bo-reactive-gated-build-enqueue]] lanes are meant to enforce (Ada's disposition is what decides `planned` vs `deferred`; a `deferred` disposition parks the spec). The `in_review` gate closes that window — the consumer no-ops on the Vale-pass event, and `applyAdaDisposition('planned')` re-fires the event so the build enqueues once Ada actually dispositions the spec. No eligibility signal is lost; the correct sequencing is enforced.

**Callers.** `autoQueueUnblockedBy` (below — the fix); Phase-2 `buildOnEligible` Inngest consumer ([[../inngest/build-on-eligible]]); Ada's own lanes MAY collapse through here as an optional refactor. The claim-time backstops (`claimHeldForUnreviewedSpec` in `scripts/builder-worker.ts` + `evaluateClaimTimeBuildGate`) stay in place as the last line of defense.

**Deliberate overrides** — raw `.insert({ kind:'build' })` sites that intentionally bypass the gate carry an inline `// intentional override:` comment: `pre-merge-fix.ts` (regression-fix ships fast, Vale reviews after), `director-directives.ts` `enqueuePriorityBuild` (CEO-approved directive), `needs-attention-route.ts` (auto-authored child spec from a parked build), this file's `queueNextChainedPhase` (chain continuation — prior phase already merged, spec has passed Vale by construction), `agents/agent-grader.ts` (director-authored coaching-hardening spec). Ada's own gated lanes in `platform-director.ts` already gate on `specReviewDone`, so their raw inserts are behaviorally equivalent.

### `enqueueSpecTestIfDue` — function  *(spec-test-on-ship)*

```ts
async function enqueueSpecTestIfDue(
  workspaceId: string, slug: string, knownStatus?: Phase,
): Promise<{ enqueued: boolean; reason?: string }>
```

The **single dedupe chokepoint** shared by all three spec-test enqueue paths: the daily backlog cron ([[../inngest/spec-test-cron]]), the manual status flip (`POST /api/roadmap/status`), and the build-merge reconcile (`reconcileMergedJobs`). Inserts one `queued` `agent_jobs` row `kind='spec-test'` for `(workspaceId, slug)` **iff** the spec is **shipped-but-not-archived** AND not already covered — **no in-flight** spec-test job (`status` ∈ `queued｜queued_resume｜building｜claimed`) **and no fresh** [[../tables/spec_test_runs]] row (last ~20h). First caller wins; the rest no-op. Re-running is allowed once the spec changes again (a fresh ship state past the window).

- `knownStatus` — when a caller already holds the freshly-derived status, pass it to skip a disk re-read of the spec (the cron passes `'shipped'`; the status route passes `deriveSpecStatus(updated)` over the just-committed content, since the deployed bundle's local disk is stale vs. that commit). Omit it to derive **shipped-but-not-archived** from disk (`getSpec` + `listArchivedSlugs`, [[brain-roadmap]]).
- **Goal-compiled specs test on the GOAL BRANCH, never main** *(spec-test-goal-branch-context)*. A member of a goal whose atomic M5 promotion hasn't landed (`goals.main_merge_sha === null`, the same signal [[spec-drift]] uses) has its code on the **goal branch, not main** — so a shipped-lane test against prod would false-fail *every* check ("migration/route/table missing" because they're not on main). Before inserting, `enqueueSpecTestIfDue` resolves such a spec's own `claude/build-*` branch + freshest captured `preview_url` (`resolveGoalMemberTestContext`) and stamps `spec_branch`/`preview_url` on the row so the worker's pre-merge testable gate runs it against the branch preview (where the accumulated code IS present). No preview captured ⇒ it **skips** rather than false-fail. Fixes the 2026-07-09 media-buyer jam: 4 members stuck on 4–9 pure wrong-context auto-fails that blocked the goal's own promotion (a self-inflicted deadlock).

### `enqueuePreMergeSpecTest` — function  *(spec-test-on-preview-pre-merge Phase 1)*

```ts
async function enqueuePreMergeSpecTest(
  workspaceId: string, slug: string, branch: string, previewUrl: string,
  opts?: { force?: boolean },
): Promise<{ enqueued: boolean; reason?: string }>
```

Sibling of `enqueueSpecTestIfDue` for the **PRE-MERGE** lane. When a `claude/*` build reaches a READY per-build preview (its `preview_url` is set by [[../specs/per-build-vercel-preview-deploys]] Phase 2) and the branch is still unmerged, this enqueues ONE `kind='spec-test'` `agent_jobs` row carrying `spec_branch=branch` (so the runner reads the branch's spec body, not `main`'s) and the **preview origin in `instructions`** (and in `preview_url` when that column is present) — Phase 2 wires the spec-test runner to point its GET / browser checks at the `*.vercel.app` PREVIEW deployment, not prod. Mirrors `enqueueSpecTestIfDue`'s dedupe shape (a `.from('agent_jobs').select('id')` SQL probe + first-hit-wins) but the key is per **(workspace, slug, branch)**: a re-run for the same branch (board refresh, webhook re-fire) no-ops instead of stacking a duplicate row, and a pre-merge run on branch A doesn't block one on branch B (different builds of the same spec). No shipped-but-not-archived gate — pre-merge is by definition not-yet-shipped. The post-ship lane keeps its own (workspace, slug) chokepoint above; the pre-merge dedupe is a STRICTLY-NARROWER key so the two never collide.

**Dedup narrowing — `error` verdicts are transient, never "already tested" ([[../specs/spectest-error-visible-and-rerunnable]] Phase 1).** The original dedup blocked re-enqueue on ANY prior spec-test job for the branch, regardless of status — so a terminal `failed` job (a reaped-mid-run session: Max cap, self-update restart) returned `in-flight` forever and the branch could NEVER be re-tested without manual DB surgery. The dedup now blocks in TWO cases only: **(a)** an OPEN spec-test job for `(workspace, slug, branch)` in `ACTIVE_STATUSES` (queued/claimed/building — that job IS the re-run in flight), OR **(b)** the latest `spec_test_runs` row for `(workspace, slug, branch)` carries a REAL verdict — `approved` / `needs_human` / `issues` (the preview was successfully tested; a re-run against the same preview would just re-derive the same result). A latest verdict of `error` (or no run row + only a terminal `failed` job) is treated as a transient failure — the enqueue proceeds, unwedging the branch. The standing-pass loop guard for auto-recovery lives in `backstopPreMergeChecks` (below).

**Branch-changed staleness ([[../specs/premerge-spectest-rerun-and-visibility]] Phase 1).** A terminal verdict for `(workspace, slug, branch)` (`approved` / `needs_human` / `issues`) also unblocks re-enqueue when the branch's CODE has changed since that run — a `build` or `pr-resolve` `agent_jobs` row for the same `spec_branch` with `updated_at > latestRun.run_at`. Root cause seen live 2026-07-02: `spec-brain-refs`'s fix landed via `pr-resolve` merging main into the branch, but its stale `issues` verdict permanently blocked re-testing on the same branch, so a fixed/rebased branch silently stalled. No churn: a spec-test run itself creates no build/pr-resolve row, so after the re-test the branch settles until the next real push. The `backstopPreMergeChecks` standing pass drives this — its per-slug `seen` set + the underlying dedup keep the re-fire idempotent across passes.

**Owner-forced re-run ([[../specs/premerge-spectest-rerun-and-visibility]] Phase 3 — `opts.force`).** An owner-initiated re-run from the /dashboard/developer/spec-tests **Pre-merge** surface passes `{ force: true }` and skips the terminal-verdict block (case **(b)**) entirely — a stuck `approved`/`needs_human`/`issues` verdict on a fixed branch can be kicked from the dashboard without waiting for a `build`/`pr-resolve` row to age out the verdict, and without waiting for the standing-pass backstop. The in-flight block (case **(a)**) still applies — an open spec-test job on the same `(workspace, slug, branch)` still refuses stacking. `force` is set ONLY by the API path `POST /api/roadmap/spec-test` with `{ slug, branch }`, which also fresh-captures the branch's Vercel preview via [[preview-capture]] `capturePreviewUrlForJob` right before the enqueue — so the forced re-test always hits the branch's CURRENT HEAD, never a stale `preview_url`.

### `maybeEnqueuePreMergeSpecTestOnAccumulation` — function  *(spec-goal-branch-pm-flow M3)*

```ts
async function maybeEnqueuePreMergeSpecTestOnAccumulation(args: {
  workspaceId: string; slug: string; branch: string | null; previewUrl: string | null;
}): Promise<{ enqueued: boolean; reason?: string }>
```

The **M3 pre-merge spec-test TRIGGER**. Under the branch-accumulation model a spec's phases build one-by-one onto ONE persistent `claude/build-{slug}` branch (each push fires a per-build Vercel preview — [[preview-capture]]). The spec-test must run ONCE against the WHOLE built spec, not per phase. So the trigger fires iff the spec is **fully accumulated on its branch** ([[specs-table]] `isSpecAccumulationComplete` — every phase carries a `build_sha` / is terminal) AND **a preview URL exists**. The worker calls this from THREE places (idempotent — the underlying `enqueuePreMergeSpecTest` dedupes per `(workspace, slug, branch)`):
1. The [[preview-capture]] poll's READY callback on the **success-push** path (`runBuildJob` in [[../recipes/build-box-setup|builder-worker]]): when the LAST phase's preview goes READY after a push, accumulation is complete → enqueue; earlier phases' previews land READY too but accumulation isn't yet complete → no-op.
2. **`finalizeBuiltPhase` at accumulation-complete** (the resume-after-approval fix): a `needs_approval` phase commits its WIP DURING the pause and the approved resume only applies the migration (no new edits → the `!dirty` branch → `finalizeBuiltPhase`), so the success-push poll callback NEVER runs for the accumulation-completing phase and the branch tip doesn't change at finalize (so the prior phase's poll doesn't re-fire). Result pre-fix: a fully-accumulated PR (`noop-pipeline-test-4` / #837) sat `in_testing` forever, `spec_test_runs` EMPTY, no branch-mode security review — the M4 tests gate could never go green. The fix: right after `ensurePr` opens the real PR, `finalizeBuiltPhase` fires a fire-and-forget `pollCapturePreviewUrl` onto THIS job row and (on READY) calls both pre-merge triggers. **BRANCH GROUND-TRUTH STAMP** ([[../specs/build-accumulation-stamp-gap-and-rollback-guard]] P1): before checking accumulation, `finalizeBuiltPhase` scans `origin/main..HEAD` for `Phase: N` trailers and stamps EVERY position present on the branch via [[specs-table]] `stampPhaseBuilt` — not just the session's own phase. Closes the wedge where a prior phase was committed during a pause but the session's derivation named only its own phase, so `isSpecAccumulationComplete` reported that prior position "not built" forever and the PR never opened (wedged every multi-phase spec on 2026-07-01: `cleo-lever-priors`, `ada-standing-pass`, `grading-cascade`).
3. **`backstopPreMergeChecks`** — the standing-pass heartbeat (below), which also recovers the case where no preview was ever captured.

The queued spec-test then materializes the spec from the DB row ([[build-spec-materializer]] reads `public.specs`+`spec_phases`, which M1/M2 stamped from this branch's commits) and points its probes at the preview URL — testing the BUILT spec on its branch preview, not main. Best-effort + never throws.

### `maybeEnqueuePreMergeSecurityOnAccumulation` — function  *(RETIRED as of fused-premerge-security-authoritative-drop-standalone Phase 3)*

```ts
async function maybeEnqueuePreMergeSecurityOnAccumulation(args: {
  workspaceId: string; slug: string; branch: string | null; previewUrl: string | null; prNumber?: number | null;
}): Promise<{ enqueued: boolean; reason?: string }>
```

**RETIRED — always returns `{ enqueued: false, reason: "retired: fused spec-test session is the sole pre-merge branch-mode security producer ..." }`.** The fused spec-test session is now the SOLE pre-merge branch-mode producer of `security-review` rows. `runSpecTestJob` emits a structured, evidence-backed security envelope alongside the spec-test verdict in ONE Max session; on completion, `applyFusedSecurityAsBranchVerdict` ([[../../../scripts/builder-worker]]) writes the authoritative branch-mode `security-review` row directly. Existing callers (the preview-ready hook + `backstopPreMergeChecks`) still call this function but get an `enqueued=false` no-op and log skipped — a future cleanup can strip the callers.

**Scope preserved:** post-merge `diff` mode + daily `dep-watch` are UNAFFECTED — those still use `enqueueSecurityReviewJob` (diff / dep-watch) and remain the authoritative post-merge / daily-CVE producers. Only pre-merge BRANCH mode is retired here.

**Historical context.** Under **`consolidate-premerge-checks-one-session` Phase 1** the pre-merge security review was FUSED into `runSpecTestJob` with a bare `security.status="clean"` envelope, which a rubber-stamp could satisfy. Under **`isolate-premerge-security-verdict` Phase 1** the fusion was REVERSED: this function was restored as the standalone enqueue and `runSpecTestJob` discarded its security envelope. **`fused-premerge-security-authoritative-drop-standalone` Phase 1** re-fused it with a STRUCTURED per-check evidence contract that a rubber-stamp cannot satisfy (a bare `clean` downgrades to `needs_human` in [[../src/lib/security-envelope]] `classifyFusedSecurityEnvelope`). **Phase 2** made the fused envelope authoritative by writing the branch-mode `security-review` row from `runSpecTestJob` via `applyFusedSecurityAsBranchVerdict`. **Phase 3** (here) retires this standalone enqueue: fused row is the sole pre-merge branch-mode producer. Best-effort + never throws.

### `backstopPreMergeChecks` — function  *(Gate-A class gap fix — standing-pass backstop)*

```ts
async function backstopPreMergeChecks(adminClient?): Promise<PreMergeBackstopResult>
```

The **standing-pass backstop for BOTH pre-merge triggers** (spec-test + security). Both enqueues fire only from the build's fire-and-forget preview-capture READY callback — the SAME event-only gap Gate-A had: a missed READY (worker restart, slow preview, transient hiccup) means the signal is never enqueued and the branch stalls `in_testing` forever. This re-evaluates every READY-preview `claude/build-*` build job (latest per slug) each platform-director standing pass and (idempotently) re-fires `maybeEnqueuePreMergeSpecTestOnAccumulation` + `maybeEnqueuePreMergeSecurityOnAccumulation`. The underlying enqueues dedupe, so running it every pass is safe + cheap. Best-effort per branch; never throws.

**fused-premerge-security-authoritative-drop-standalone Phase 3 — security leg gone.** The backstop's spec-test re-fire remains active + IT is what produces the authoritative pre-merge security verdict (via the fused envelope + `applyFusedSecurityAsBranchVerdict`). The security leg (`maybeEnqueuePreMergeSecurityOnAccumulation`) is no longer called from the backstop — `securityEnqueued` on the result shape stays for backward-compat with the platform-director's standing-pass logging but is always empty. No separate branch-mode `enqueueSecurityReviewJob` fires from the pre-merge path anymore.

**No-captured-preview recovery (resume-after-approval fix — `noop-pipeline-test-4` / #837).** The original backstop scanned only branches whose build row already carries a **READY** preview — but the resume-after-approval finalize path never captures the branch tip's preview (the `commitWip` push at the `needs_approval` pause pushes the branch but kicks no `pollCapturePreviewUrl`, and the resume's `!dirty` finalize pushes nothing). So #837's latest build row had `preview_state` null and the READY-only scan skipped it forever → permanent `in_testing` with EMPTY `spec_test_runs`. The backstop now adds an **on-demand capture** for the latest build row of an in-flight spec whose preview isn't READY, gated tight to avoid hammering Vercel: only when the spec is **fully accumulated** (`isSpecAccumulationComplete`), has an **open PR** (`pr_url`/`pr_number`), and has **NO `spec_test_runs` row for `(workspace, slug, branch)` yet**. It calls `capturePreviewUrlForJob({ jobId, branch, commitSha: null })` to persist the branch tip's preview onto that row, then falls through to the normal spec-test + security triggers. Idempotent (`capturePreviewUrlForJob` only advances the row forward; once a run exists the recovery short-circuits). This is the heartbeat that self-recovers any spec stuck the way #837 was.

**Refresh-on-change: fresh preview for a changed branch ([[../specs/premerge-spectest-rerun-and-visibility]] Phase 2).** Phase 1 unblocks the re-enqueue for a changed branch (a `build`/`pr-resolve` `agent_jobs` row with `updated_at > latestRun.run_at` marks the terminal verdict stale), but that alone isn't enough: the build row's captured `preview_url` may itself be STALE — a `pr-resolve` merge commit pushes a fix to the branch but never re-captures a preview onto THIS row, so re-enqueuing with the row's URL would re-test the OLD code and re-fail. So when the branch has newer `build`/`pr-resolve` activity than its latest `spec_test_runs` row (even if the READY-scan already passed), the backstop asks Vercel for the branch's newest deployment via [[vercel-project]] `getLatestReadyDeploymentForBranch`: if its state is **READY** (Vercel finished building the new push), it persists the fresh URL onto this row via `capturePreviewUrlForJob` and uses it for both enqueues; if **NOT READY** (still QUEUED/BUILDING/ERROR/CANCELED — or Vercel hasn't listed a deployment yet), the backstop SKIPS this branch for the pass and retries on the next standing pass. Never enqueue against a stale or non-READY preview. The Vercel call is gated behind the newer-work check so it's bounded to real change events, not fired every pass on every branch. Root cause seen live 2026-07-02 on `spec-brain-refs`: the `pr-resolve` fix landed but its stale preview URL, if re-enqueued naïvely by Phase 1 alone, would still probe the pre-fix code.

**Error-verdict auto-recovery + loop guard ([[../specs/spectest-error-visible-and-rerunnable]] Phase 1).** With `enqueuePreMergeSpecTest`'s dedup narrowed (an `error` verdict is a transient, not "already tested"), the backstop's standing-pass re-fire now naturally recovers a reaped/errored pre-merge spec-test on the next pass — no separate code path needed. To stop a **genuinely-erroring** run (a real repro-able crash, not a one-off reap) from re-firing every pass, the backstop caps standing-pass auto-recovery at **ONE retry per branch**: before calling `maybeEnqueuePreMergeSpecTestOnAccumulation`, it counts `spec_test_runs` rows with `agent_verdict='error'` for `(workspace, slug, branch)`; if ≥2, it SKIPS the spec-test enqueue for this pass. A manual `TestNow` re-fire (the Phase 2 route) bypasses this cap — the guard only silences the standing-pass loop, not owner-driven retries. Security re-fires still run each pass (independent leg).

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

The **spec→goal-branch promotion poll** — the M4 integration. For every GOAL-BOUND spec that is `isSpecPromoteEligible` (M3 seam — accumulation ∧ spec-test-green ∧ security-green on its `claude/build-{slug}` branch) and not yet on its goal branch (`goal_branch_sha` unset), it merges that branch into **`goal/{goal-slug}`** (created from `origin/main` by the FIRST spec of the goal — that spec SEEDS it) and stamps `specs.goal_branch_sha` with the merge commit (via [[specs-table]] `stampSpecGoalBranchSha` — the M5 seam). Uses the GitHub `/merges` API ([[github-pr-resolve]] `mergeSpecBranchIntoGoalBranch`) — **no local checkout** — so it runs identically from the box worker standing pass AND the [[../integrations/github]] webhook (mirroring `autoMergeReadyPrs`). **Merges are sequenced by `blocked_by`** (`sequencePromoteCandidates`, a Kahn topo-sort over goal-mate edges) so a dependency lands on the goal branch before its dependent — which then BUILDS off the goal branch (`runBuildJob` Part 2), seeing the dependency's code. **CRITICAL: `blocked_by` entries MUST be plain kebab slugs** (e.g. `sol-ticket-direction-artifact`), never namespaced (e.g. `goalSlug:specSlug`). The `sequencePromoteCandidates` topo-sort looks each entry up by exact slug match and does NOT split on `:` — a namespaced entry resolves to no spec and lets the dependent build out-of-order ([[goal-member-blocked-by]] Phase 2 validates/repairs drift; [[goal-proposals]] Phase 1 normalizes Pia's decomposition write-path). ONE merge per spec (idempotent — already-stamped specs skip; the `/merges` 204 path is idempotent). **Does NOT push the goal branch to main** (that's M5's atomic goal→main promotion). **Conflicts are surfaced** (`conflicts[]`), never silently dropped. Best-effort per spec; never throws.

### `resolveGoalSlugForSpec` / `areSpecsGoalMates` — functions  *(spec-goal-branch-pm-flow M4)*

```ts
async function resolveGoalSlugForSpec(workspaceId, slug): Promise<string | null>
async function areSpecsGoalMates(workspaceId, slugA, slugB): Promise<boolean>
```

`resolveGoalSlugForSpec` resolves the GOAL a spec belongs to via `specs.milestone_id → goal_milestones.goal_id → goals.slug` (null = one-off / not goal-bound). `areSpecsGoalMates` = both resolve to the SAME non-null goal slug. The claim-time blocked_by gate ([[../recipes/build-box-setup|builder-worker]] `evaluateClaimTimeBuildGate`) uses these to pick the right blocker-clearance: a **goal-mate** blocker is cleared when ON THE GOAL BRANCH ([[specs-table]] `isSpecOnGoalBranch` — a goal-mate never ships to main until M5's atomic promotion), an **external** blocker (one-off / different goal) is cleared when SHIPPED. This is the load-bearing fix that stops a goal-mate dependent deadlocking forever (its blocker can't ship until the whole goal promotes). **NOTE:** the goal-mate check reads `blocked_by` via exact slug match and does NOT split on `:` (see [[goal-member-blocked-by]] why-this-exists for the format requirement). The spec-branch base in `runBuildJob` also calls `resolveGoalSlugForSpec` to base a goal-bound fresh spec branch on `origin/goal/{goal-slug}` when that branch exists.

### `evaluateGoalMemberBuildDispatch` / `decideGoalMemberBuildDispatch` — functions  *(serialize-goal-member-spec-builds Phase 1)*

```ts
async function evaluateGoalMemberBuildDispatch(workspaceId: string, slug: string): Promise<GoalMemberBuildDispatchVerdict>
function decideGoalMemberBuildDispatch(thisSpec: Spec, goalSpec: Spec[], inFlightBuildForGoal: AgentJob | null): 'claimable' | 'queued' | 'ineligible'
```

Goal-bound specs of the SAME goal must serialize on build (concurrent builds collide on hot files like `action-executor.ts`). `decideGoalMemberBuildDispatch` is a **pure predicate** that returns the dispatch verdict for a spec being claimed:
- **`'claimable'`** — this spec is eligible to build NOW. TRUE when: (a) no other goal-mate build is in-flight (claimed/building), AND (b) this spec is the EARLIEST ready goal-member in `blocked_by`-topological order (Kahn-sorted, slug tiebreak for determinism).
- **`'queued'`** — this spec must wait. Return when a goal-mate build blocks it. The spec stays `queued` (requeue disposition) so the next platform-director standing pass re-evaluates it as the prior sibling merges onto the goal branch.
- **`'ineligible'`** — one-off spec (no goal) or resolution failed — no-op (falsy goal slug = falsy gate).

`evaluateGoalMemberBuildDispatch` is the **DB reader** — calls `resolveGoalSlugForSpec` (get the goal), `getGoalSpecMembersInOrder` (list goal-mates in blocked_by order), `listAgentJobs` (check for in-flight builds), and invokes the pure predicate. Wired into `scripts/builder-worker.ts` `evaluateClaimTimeBuildGate` **leg 4** (the 4-leg claim gate: 1-goal-bound-validation, 2-blocked_by-clear, 3-vale-pass, **4-goal-member-serialize**, 5-one-off-fallback) — after blocked_by clearance, before Vale check. Never throws; fails OPEN (a read error → treat as `'ineligible'` → no-op gate, the downstream tests still protect).

### `evaluateGoalMemberEnqueueAdmission` / `decideGoalMemberEnqueueAdmission` — functions  *(goal-member-builds-gate-at-enqueue-not-at-claim Phase 1)*

```ts
type GoalMemberEnqueueAdmissionResult = { ok: true } | { ok: false; reason: string };
function decideGoalMemberEnqueueAdmission(input: { slug, goalSlug, inflight: GoalMemberInflightRow[] }): GoalMemberEnqueueAdmissionResult
async function evaluateGoalMemberEnqueueAdmission(workspaceId, slug): Promise<GoalMemberEnqueueAdmissionResult>
```

The **enqueue-time admission gate**. `evaluateGoalMemberBuildDispatch` (above) serializes goal-mate builds at CLAIM time — N goal-mates land as `queued` rows and the claim-gate then re-queues the losers each tick. That prevents the race but leaves the CEO's board looking like the whole goal is a live pile-up. This helper moves the (b) "no other goal-mate build in-flight" leg UP to enqueue: before `enqueueBuildIfDue` / `queueNextChainedPhase` / `queueRoadmapBuild` (in [[roadmap-actions]]) inserts a `kind='build'` row, it consults the admission gate. If ANY goal-mate row is in `ACTIVE_STATUSES` (queued / queued_resume / claimed / building / needs_input / needs_approval / blocked_on_usage), the insert is REFUSED with reason `serialized-goal-mate-in-flight` and the spec stays ELIGIBLE-BUT-UNQUEUED — the reactive path (`buildOnEligible` / `autoQueueUnblockedBy` / the chain reconciler) re-fires the moment the sibling completes. The pure `decideGoalMemberEnqueueAdmission` predicate is the seam the [[../specs/goal-member-builds-gate-at-enqueue-not-at-claim]] Phase 1 test pins ("two back-to-back enqueues leave exactly one row"). The reader `evaluateGoalMemberEnqueueAdmission` does the DB work above it: `resolveGoalSlugForSpec` (one-off / null goal ⇒ ok:true) → `goalBranchState` (list member slugs) → `agent_jobs` `.in('status', ACTIVE_STATUSES).neq('spec_slug', slug)` (any goal-mate row) → predicate. Fail-OPEN on any resolve error (the claim-time serializer is still in place as a backstop until Phase 2 retires it). Does NOT retire `evaluateGoalMemberBuildDispatch` / the claim-gate leg 4 — that's Phase 2 of this spec.

### `admitNextGoalMemberOnCompletion` / `pickNextGoalMemberCandidates` — functions  *(goal-member-builds-gate-at-enqueue-not-at-claim Phase 2)*

```ts
interface GoalMemberReleaseCandidate { slug: string; status: SpecStatus | null; onGoalBranch: boolean; }
function pickNextGoalMemberCandidates(input: { completedSlug, members: GoalMemberReleaseCandidate[] }): string[]
async function admitNextGoalMemberOnCompletion(workspaceId, completedSlug): Promise<string | null>
```

The **release side** of the enqueue-time serial gate. Phase 1 (above) refused a second goal-mate at enqueue time; Phase 2 makes the goal's serial slot admit-and-refill automatically the moment the active member merges — no standing-pass wait. `admitNextGoalMemberOnCompletion` runs from `applyMergedBuildEffects` (the shared post-merge body — [[#reconcileMergedJobs]] + [[#handleAutoMergedBuildBranch]]), ORDERED AFTER `queueNextChainedPhase` so a chain_phases=true spec's next phase queues FIRST + re-occupies the slot; the release then observes the freshly-queued next-phase row via Phase 1's admission gate and no-ops. When the completed spec has no chain continuation (or its rollup shipped), the release walks `pickNextGoalMemberCandidates` (alphabetical order — the same Kahn tiebreak Phase 1 uses so a re-run picks the same head) and delegates to `enqueueBuildIfDue` on each candidate. `enqueueBuildIfDue`'s existing gates (Vale pass / blocked_by / auto_build) still apply per candidate — a not-yet-review-passed / blocked member is skipped and the NEXT candidate is tried. The FIRST admission that lands wins the goal's serial slot; Phase 1's `evaluateGoalMemberEnqueueAdmission` then refuses every subsequent candidate → **exactly one** goal-mate lands per completion. Best-effort per candidate (never throws — the daily platform-director standing pass is the backstop). Retires the claim-time serializer at [[../recipes/build-box-setup|builder-worker]] `evaluateClaimTimeBuildGate` **leg 4** to a DEFENSIVE ASSERTION: it now WARN-logs (`[phase1-gate-leak]`) + requeues with reason `claim-gate defensive assertion (phase1-gate-leak): …` if Phase 1's fail-open path ever admits a second goal-mate — the healthy-run signature is now "no [phase1-gate-leak] logs and no 'held until the goal serializer releases' phrase anywhere in the run" (the old requeue reason is deleted).

### `reconcileDirtyGoalMemberPrs` / `decideGoalMemberPrRedrive` — functions  *(serialize-goal-member-spec-builds Phase 2)*

```ts
async function reconcileDirtyGoalMemberPrs(adminClient?): Promise<DirtyGoalMemberPrResult>
function decideGoalMemberPrRedrive(prMergeable: PrReadOutcome, reason?: string): 'redrive' | 'skip'
```

Goal-bound spec PRs can become DIRTY when their base (the goal branch) advances — the spec branch was rebased onto an earlier goal-branch state. `decideGoalMemberPrRedrive` is a **pure predicate** that returns the redrive verdict for a goal-member PR:
- **`'redrive'`** — enqueue a `pr-resolve` job. TRUE when: the PR is open (not merged/closed) AND `mergeable_state ∈ {dirty, behind}` (a real conflict or behind-base, requiring rebase/rebuild).
- **`'skip'`** — leave the PR untouched. TRUE when: PR read failed (`null` outcome), `mergeable_state` is `unknown/null/clean/unstable/blocked`, or the PR is `merged`/`closed`.

`reconcileDirtyGoalMemberPrs` is the **standing-pass reconciler** — enumerates open goal-member build PRs (from `agent_jobs` rows with goal-bound specs via `resolveGoalSlugForSpec`), reads each PR's status via [[github-pr-resolve]] `getPr` (which now returns `mergeableState` + `baseRef`), and idempotently enqueues a `pr-resolve` job on `'redrive'` verdict. Skips one-off specs (already covered by the main-based `detectAndEnqueueDirtyPrs` lane). Wired into `scripts/builder-worker.ts` **standing pass** alongside `detectAndEnqueueDirtyPrs` (the mirror lane for one-off PRs). Idempotent (`enqueuePrResolveJob` dedupes per PR) + retry-capped (3 attempts max per PR). Best-effort per PR; never throws. Phase 2 also widened [[github-pr-resolve]] `getPr` to include `mergeableState` (from GitHub's `mergeable_state`) + `baseRef` (from `pr.base.ref`), enabling dynamic base-branch reads for `runPrResolveJob` (see [[github-pr-resolve]] § "Exports").

### `promoteCompleteGoalsToMain` — function  *(spec-goal-branch-pm-flow M5 — the ATOMIC goal→main promotion)*

```ts
interface GoalPromotionEffects { stampedSpecs: string[]; phasesStamped: number; foldsTriggered: string[]; foldedNow: string[]; }
interface GoalFinalizeResult { completed: boolean; foldQueued: boolean; reason?: string; }
interface PromoteGoalsToMainResult { promoted: string[]; conflicts: string[]; parentExempt: string[]; notReady: string[]; effects: Record<string, GoalPromotionEffects>; finalized: Record<string, GoalFinalizeResult>; }
async function promoteCompleteGoalsToMain(adminClient?): Promise<PromoteGoalsToMainResult>
```

The **atomic goal→main promotion poll** — M5, one hop past M4. For every GREENLIT (non-`proposed`/non-`folded`) goal in the build-console workspace it gates in order: **(1) parent-goal exemption** — skip a parent via [[goals-table]] `isGoalParentExempt` (`is_parent` flag OR has child goals OR no buildable specs — a parent has no goal branch; its children promote independently); **(2) goal-complete** — require [[specs-table]] `goalBranchState(goalSlug).allOnGoalBranch` (every member spec integrated on the goal branch — M4's seam); **(3) GREEN** (option b, combination-verified without extra preview deploys) — require EVERY member spec individually `isSpecPromoteEligible` on its own branch (accumulation ∧ spec-test-green ∧ security-green — already tested), and the atomic merge itself is the final combination check (each dependent built OFF the goal branch, so the integrated whole was compiled together; a clean land confirms no `main` drift); **(4) promote** — [[github-pr-resolve]] `mergeGoalBranchIntoMain(goalSlug)` merges `goal/{slug}` → main in ONE merge, then `applyGoalPromotionEffects(workspace, goalSlug, mergeSha)` stamps shipped + reactive-folds the specs, then `finalizePromotedGoal(workspace, goalSlug)` retires the goal (greenlit → complete + enqueue the `goal-fold` lane). A **409 conflict** HOLDS the goal (`conflicts[]`, nothing stamped). Runs from the SAME seams M4 uses (box worker standing pass + the Gate-C github webhook); GitHub `/merges` API (no checkout). Idempotent (a goal already on main merges as a 204 + re-stamps inertly), best-effort per goal, never throws. **One-off (no-goal) specs do NOT promote here** — they ship via the Gate A auto-merge of their `claude/build-{slug}` branch (see `applyMergedBuildEffects` whole-spec stamping below).

### `applyGoalPromotionEffects` — function  *(spec-goal-branch-pm-flow M5 — the ONLY shipped-writer)*

```ts
async function applyGoalPromotionEffects(workspaceId, goalSlug, mergeSha): Promise<GoalPromotionEffects>
```

The **promotion EFFECTS of an atomic goal→main merge**: flip EVERY phase of EVERY member spec of `goalSlug` to `shipped`, tagged with `merge_sha = mergeSha` (the main merge commit), then trigger the fold pipeline. This is the **only shipped-writer in the branch-flow** (M2–M4 reserved `status='shipped'` + `merge_sha` for exactly here — `build_sha`'d / `in_progress` phases stay `in_progress` until this moment). Reuses [[specs-table]] `stampPhaseShipped` per phase (SDK-only — no raw PM SQL); a phase already `shipped`/`rejected` is left as-is (idempotent). Then mirrors `applyMergedBuildEffects`' post-ship hook **in full** (post-M5-goal-finalization): **(1)** `stampSpecMergeProvenance(slug,{pr:null,merge_sha})` for EVERY member spec (the atomic merge has no per-spec PR, so `merged_pr` stays null but card-level `last_merge_sha` carries the SHA — without it the card reads drift-suspect); **(2)** `enqueueSpecTestIfDue(ws, slug, 'shipped')` (no-ops if a fresh run exists); **(3)** `reactiveFoldOnGateComplete(ws, slug)` — the SAME reactive fold a one-off uses; the spec is now genuinely derived-`shipped` (the in_testing deriver treats a phase `merge_sha` as "on main") so it folds the instant M5 runs; **(4)** `autoQueueUnblockedBy` (release dependents). `foldedNow[]` records the specs the reactive fold actually folded. Best-effort per spec.

### `finalizePromotedGoal` — function  *(post-M5-goal-finalization — retire a promoted goal)*

```ts
async function finalizePromotedGoal(workspaceId, goalSlug, adminClient?): Promise<GoalFinalizeResult>
```

**Retire a goal that just promoted to main** — the gap-closer so a promoted goal doesn't linger `greenlit`. Two sanctioned steps: **(1)** [[goals-table]] `setGoalStatus(goalId, 'complete')` — the explicit `greenlit → complete` lifecycle override (the board *derives* `complete`, but the stored column stays `greenlit` after M5, and the goal-fold lane's guard reads the *stored* status); skipped if already `complete`/`folded`. **(2)** enqueue ONE `kind='goal-fold'` `agent_jobs` row (deduped on an in-flight goal-fold for the slug; skipped if the goal is already `folded`) — the goal-fold lane folds the goal's durable knowledge into the permanent brain pages and flips `goals.status='folded'`. Called by `promoteCompleteGoalsToMain` right after `applyGoalPromotionEffects`, so it fires for EVERY goal post-M5 in both seams (box standing pass + Gate-C webhook). `agent_jobs` is not a PM table, so the goal-fold enqueue is a plain insert; the goal-status write is the only PM write, via the SDK. Best-effort + idempotent; never throws.

### `reconcileCompletedGoalsToFolded` — function  *(completed-goal-self-archive — the standing fold reconciler)*

```ts
async function reconcileCompletedGoalsToFolded(workspaceId, adminClient?): Promise<CompletedGoalFoldResult>
```

**Self-archive a COMPLETE non-parent goal** — the FORWARD fix so a 100% goal never sits stranded on the active board awaiting a manual backfill. `finalizePromotedGoal` (above) retires ONLY a goal that shipped THROUGH a goal branch; a **legacy goal whose member specs shipped one-off** (no `goal/{slug}` branch → the M5 promoter never evaluated it) reaches a 100% rollup but never gets the greenlit→complete + goal-fold enqueue — it lingers FOREVER as `greenlit`/`complete` (the 8 goals Dylan hand-folded). This standing reconciler re-evaluates the FULL active goal set each pass via [[brain-roadmap]] `getGoals` (folded goals are off that read = never a candidate) and, for each goal: **(1) ROLLUP 100%** — require the DERIVED card `status === 'complete'` (every milestone rolls up complete = every member spec shipped|folded) AND `linkedSpecCount >= 1` (never fold an empty 0-spec goal); **(2) PARENT EXEMPTION** — skip via [[goals-table]] `isGoalParentExempt` (`is_parent` flag **OR** has child goals — `goalHasChildGoals` counts EVERY child row incl. already-folded children, the structural signal that exempts `ceo-mode` — **OR** no buildable specs); a parent stays active at 100% awaiting its sub-goals and NEVER auto-folds; **(3) FOLD** — reuse `finalizePromotedGoal` (greenlit/complete → complete + goal-fold enqueue). Wired into [[../lifecycles/roadmap-build-console]]'s `runPlatformDirectorStandingPass` right after the M5 goal→main promote block. Idempotent (a folded goal is off `getGoals`; an in-flight goal-fold is deduped → reported `kept`, never double-enqueued), bounded (the active set), and LOGGED — one `reconciled_completed_goal_folded` [[../tables/director_activity]] row per goal folded (never silent). Best-effort per goal; never throws.

### `reconcileMergedJobs` — function

```ts
async function reconcileMergedJobs(jobs: AgentJob[]): Promise<void>
```

Self-heal: a `completed` job whose PR was merged/closed **outside** the dashboard still shows a stale "Squash & merge" button. Checks GitHub; if the PR is no longer open, flips the job to `merged` (in place + persisted). When a merged (`pr.merged`) `kind='build'` job is flipped, it delegates to **`applyMergedBuildEffects(workspace, slug, { chainPhases, mergeSha })`** — the shared post-merge body. This only fires on the **completed→merged transition**, so a job the auto-merge path already flipped `merged` (via `handleAutoMergedBuildBranch`) is never re-processed here (the two paths never double-run for one merge). Called on board load ([[../dashboard/roadmap]]) and the merge path (`/api/roadmap/build`).

### `applyMergedBuildEffects` — function  *(chain-and-cardstate-under-automerge Phase 1)*

```ts
async function applyMergedBuildEffects(workspaceId, slug, { chainPhases?, mergeSha? }): Promise<void>
```

The shared post-merge body for a merged `kind='build'` job, run identically by **both** paths that flip a build to `merged` — the board-render reconcile (`reconcileMergedJobs`, manual squash-merge) and the auto-merge webhook path (`handleAutoMergedBuildBranch`). **100% DB-driven** ([[../specs/retire-md-reads-from-pm-flow]] Phase 2): reads `public.specs` + `public.spec_phases` via [[specs-table]] `getSpec` — no `spec_card_state` mirror read, no `spec-drift` markdown round-trip. Steps (each best-effort/idempotent): **(1)** TRUST THE MERGE: stamp the phase(s) this merge shipped via `stampPhaseShipped(workspace, slug, position, { pr, merge_sha })`. Phase selection (**ship-all-phases-on-squash-merge** — the post-merge-ships-only-one-phase fix): **accumulation-complete now wins FIRST** — a squash-merge collapses the WHOLE accumulated `claude/build-{slug}` branch into one commit on main, so when `isSpecAccumulationComplete` is true (the M2 gate only ever merges a fully-built branch) stamp **EVERY** non-terminal phase shipped, *regardless of which phase the build's `instructions` name*. (The old order checked the named-phase shortcut first, so a director-initiated / chain build whose `instructions` said "Phase 2" stamped ONLY P2 and left P1 `in_progress` forever — `noop-pipeline-test-4` / #837.) **Fallbacks** when NOT fully accumulated (the now-rare partial merge): the instructions name `Phase N` (`parsePhaseIndices`) → those positions; else advance the first not-yet-shipped phase. A single-phase spec advances its one phase; a one-shot spec (zero phases) records `merged_pr` / `last_merge_sha` on the `specs` row. This is how a one-off promote-eligible spec ships ALL its phases on its single auto-merge to main; **(2)** roll up the post-stamp phase set via `rollupPhaseStatus` to compute the new derived status; **(3)** when fully shipped: `enqueueSpecTestIfDue(...,'shipped')` **then** `autoQueueUnblockedBy(...)` (spec-blockers Phase 2); **(4)** every merge: `enqueueSecurityReviewJob` ([[../specs/security-dependency-agent]] Phase 1, deduped by `mergeSha`); **(4b)** every merge: [[ship-time-backfill-detector|`detectAndEscalateShipTimeBackfills`]] ([[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] Phase 1) — scans the merged PR's added files for `scripts/_backfill-*.ts` additions, upserts a `pending` row per file into [[../tables/data_op_runs]], and escalates any row without a successful `ran` outcome to the CEO inbox (best-effort + idempotent — the detector dedupes its own escalation per `(spec_slug, script_path, UTC day)`); **(5)** if `chainPhases`: `queueNextChainedPhase(...)` advances the "Build all" chain off the merge itself, no board render; **(6)** `retestOriginIfFixMerged(...)` (fix-ship-retests-origin) — re-tests the origin spec if `specs.regression_of_slug` links one; **(7)** `enqueueDirectorTopUp(workspace)` ([[../specs/director-initiation-throughput]] Phase 3 — this merge freed a build lane, so trigger a director standing-pass top-up to re-saturate the pool within seconds). Never throws.

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

### `queueNextChainedPhase` — function  *(build-all-phases-chain Phase 1 · chained-phase-session-resume Phase 1)*

```ts
async function queueNextChainedPhase(workspaceId: string, slug: string): Promise<string | null>
```

Advance the phase chain. Reads the spec **in the passed `workspaceId`** (`getSpec(slug, workspaceId)` — load-bearing: a spec in a non-default workspace would otherwise resolve the WRONG workspace and find no phases), finds the **next ⏳ phase** (the first `planned` phase — a built phase carries `build_sha` and reads `in_progress`, so it's skipped), and queues it onto the next phase's build job. Returns the queued phase title, or null (no `planned` phase remains → chain complete). **De-duped:** skips when a build job already carries that phase's scoped instructions, OR any build job for the spec is in flight (`status` ∈ ACTIVE_STATUSES). Best-effort.

**Phase 1 — Resume the prior phase's session to cache-warm the next phase (guarded)** ([[chained-phase-session-resume]] Phase 1). Instead of enqueueing a FRESH `queued` build that re-hydrates everything from scratch, the next phase is enqueued as `queued_resume` carrying the **prior phase's `claude_session_id` + `claude_session_config_dir`** (copied from the just-merged phase's build job onto the next phase's row). The build dispatch (`resolveAccountForJob` → `runBoxSession --resume`) continues the prior session via [[../integrations/anthropic]] prompt-cache resumption, serving the transcript from cache (~0.1x cost) instead of re-reading the full branch + spec from scratch. Phases run back-to-back (~10-15 min each, within the ~1h prompt-cache TTL), so this cuts usage-wall burn and redundant exploration. **Guarded — resume only if ALL hold, else enqueue FRESH** (`queued`, no session):
  - **(a) OWNING ACCOUNT HEALTHY** — a cross-account `--resume` is a guaranteed 'No conversation found', so the owning account must be un-capped. `resolveAccountForJob` already pins a resume to its owner and starts fresh when that owner is capped — honor that safeguard.
  - **(b) WITHIN CACHE WINDOW** — resume only if the gap since the prior phase's last activity is under ~55m (under the 1h prompt-cache TTL); past that the transcript is cold and re-read at full price, so fresh is cheaper. Use the prior phase's `agent_jobs.updated_at` / `last_heartbeat_at`.
  - **(c) TRANSCRIPT NOT HUGE** — skip resume when the session is over a size cap; a many-phase spec's accumulated session grows large enough that 0.1x reads + context-window pressure argue for a fresh reset.

Fresh-start is the safe fallback — the phase's code is committed on the branch, so nothing is lost; resume is purely an optimization.

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

Auto-queue on unblock. `shippedSlug` just shipped (its build PR merged + phases flipped ✅); this finds every **live** spec (via `getRoadmap`) that named it in `**Blocked-by:**` and, if that was its **last** uncleared blocker (`blockedBy.every(b => b.cleared || b.slug === shippedSlug)` — `shippedSlug` is treated as cleared so a deploy-stale disk snapshot of its status can't suppress the unblock), routes each dependent through **`enqueueBuildIfDue`** (above — the gated chokepoint). The chain goes hands-off: merge the prerequisite, the dependent build fires itself. **Skips** a dependent that already has ANY `build` job (dedupe — *one auto-queue per spec*, so calling this on every board load no-ops), is itself `shipped`, or opted out via `**Auto-build:** off` (`SpecCard.autoBuild === false`). Returns the slugs it actually queued. Called from `applyMergedBuildEffects` (on the shipped transition).

**Gated as of [[../specs/bo-reactive-gated-build-enqueue]] Phase 1.** Before the fix, this path raw-inserted a `kind='build'` row and ONLY checked `autoBuild !== false` + blockers cleared + a build-row-exists dedupe — an unblocked-but-un-Vale-passed dependent got a premature build row that the claim-gate held indefinitely (the "premature row on the board" symptom the CEO reported). Now the raw insert is replaced by `enqueueBuildIfDue`, which re-checks the FULL eligibility gate (`specReviewDone` + not-deferred + not-shipped + `auto_build` + blockers + in-flight); if the dependent hasn't passed Vale yet the enqueue no-ops with `reason:'not-review-passed'` and Phase 2's reactive `build/spec-build-eligible` Inngest event re-fires when Vale passes.

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
- **`cancelJobsForArchivedSpecs`** (cleanup backstop) — for every reapable `build`/`spec-test` job whose `spec_slug` is **either** in the FS archive (`listArchivedSlugs`, `archive.d/`, global) **or** DB-folded/deferred in its own workspace (`specs.status IN ('folded','deferred')`, read via [[specs-table]] `listSpecs` — never a raw `.from('specs')`, per the [[../operational-rules]] SDK rule), flips it `status='completed'` `error='spec archived — build auto-cancelled …'` and clears `questions`/`pending_actions`, so no orphaned card survives a fold that raced a build. **"Reapable" = `REAPABLE_STATUSES_FOR_ARCHIVED_SPECS` = `ACTIVE_STATUSES ∪ {'needs_attention'}`** ([[../specs/reap-needs-attention-jobs-for-archived-specs]] Phase 1) — a LOCAL widening scoped to this cleanup path; `ACTIVE_STATUSES` itself stays intact for its other callers (fold-guard, in-flight seams, resume gates). The needs_attention leg is the fix for parked build jobs that survived a fold (an earlier build parked at needs_attention, a later build shipped + folded the spec, leaving the parked job orphaned) — before the widening, they lingered forever and Ada's [[platform-director]] `platformHasPendingWork` "builds stuck >90m" standing pass re-flagged the shipped spec every sweep (observed 2026-07-12 for `director-sms-cockpit-per-director` + `claim-rpc-kill-switch-enforcement`, cancelled by hand). Grouped by `workspace_id` so a DB-archived slug in workspace A never cancels workspace B's job of the same slug (the DB set is workspace-scoped; the FS set is global). Global by default (all workspaces); `workspaceId` scopes it. Idempotent (terminal jobs untouched), best-effort (one failed update never aborts the rest). Returns `{ cancelled, slugs, prsClosedOk, prResolveCancelled }`. **PHASE 2 — orphan PR closure ([[../specs/pr-resolve-retry-cap-and-fold-closes-orphan-pr]] Phase 2):** for every cancelled BUILD job that carries an open `claude/*` PR (`pr_number != null` + `spec_branch` starts with `claude/`), this function also (a) **closes the PR** via [[../libraries/github-pr-resolve]] `closeArchivedSpecPr` with a note explaining the spec folded, and (b) **cancels its pr-resolve jobs** — all `pr-resolve` rows for the PR (`pr_number` match, `kind='pr-resolve'`, same workspace) are flipped to `completed` with error "spec archived — pr-resolve reaped". The dirty-PR backstop standing pass then has no stray job left to re-enqueue, terminating the 61-job firehose. Only `build` kind mints the `claude/*` PR, so `spec-test` jobs contribute nothing here. Both mutations are scoped + guarded (workspace_id, kind filter, REAPABLE status check) and best-effort — a GitHub error never rolls back the build-job cancellation above. Wired into **two spots**: the box worker's `reapArchivedSpecJobs` at startup ([[../recipes/build-box-setup]] § Startup orphan-reaper) and the `kind='fold'` merge reconcile (board load after a fold PR merges). The pure decision halves are exported as `filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs)` and `collectArchivedSpecOpenPrs(jobs)` — unit-tested in `agent-jobs.cancel-archived-db-folded.test.ts` (FS/DB gate), `agent-jobs.reap-needs-attention-archived.test.ts` (reapable includes needs_attention), and `agent-jobs.fold-closes-orphan-pr.test.ts` (PR closure + pr-resolve reap). **Why the DB union matters** ([[../specs/cancel-jobs-for-archived-specs-reads-db-fold-not-just-markdown]]): a spec folded/deferred purely in the DB (`setSpecStatus` sets the override; the FS `archive.d/` file may lag or no longer exist post-markdown-retire) previously left its stuck `needs_approval` build job running — this happened live 2026-07-14 for `media-buyer-agent-test-mock-support-neq-filter`, cancelled by hand. **Why PR closure matters** ([[../specs/pr-resolve-retry-cap-and-fold-closes-orphan-pr]] Phase 2): a folded spec's still-open PR is the orphan the retry-cap storm rides on — its `pr-resolve` jobs keep re-enqueuing from the backstop because there's nothing left to close the PR. Proactively closing it so the standing-pass dirty-PR backstop finds no open PR to re-enqueue is the fold path's share of cleanup, not just Mario's.

### `getBranchBuildSuccess` — function  *(optimizer-launch-hardening Phase 2 / M4 promote-on-green seam)*

The **auto-merge SUCCESS GATE**. The repo has no CI / branch protection, so GitHub reports `mergeable_state==="clean"` for any non-conflicting `claude/*` PR — vacuous. The real proof a build succeeded is its OWN `agent_job`: the worker drives the branch's owning job to `completed` only after its pre-push `tsc` passed (→ `merged` once it lands). Returns `{ ok, status, reason, workspaceId, specSlug }` for a branch; consumed inline by the [[github-pr-resolve]] auto-merge gate (build-gate + the M4 TESTS gate's `isSpecTestGreenForBranch(wsId, slug, branch)` lookup) and by the `claude/fold-*` / `claude/goal-fold-*` fold gate. **Fails CLOSED** — read error / missing owning job ⇒ `ok:false` (this is the rail that refuses an UNOWNED manual/untracked push — no `agent_jobs` row ⇒ "no build job owns this branch" ⇒ left for the owner).

**Two distinct resolutions inside this one function — don't conflate them:**

- **Build STATUS** (`ok`/`status`/`reason`) comes from the NEWEST `BRANCH_OWNING_KINDS` job (`build` | `fold` | `goal-fold` | `pr-resolve`) for the branch. This is correct: a `pr-resolve` that just cleaned a dirty PR reading `completed` legitimately means the branch is in a good state. `goal-fold` was added 2026-06-29 — a completed goal-fold job (`claude/goal-fold-*`, the post-M5 `finalizePromotedGoal` lane) is the SYSTEM authoring brain-doc changes, the same standing a `build`/`fold` job has, so it must clear this gate (it previously didn't, leaving goal-fold PRs unmergeable as "no build job owns this branch").
- **`specSlug` + `workspaceId`** come SEPARATELY from the newest **`build`** job (`REAL_SLUG_BUILD_KINDS`) for the branch — the ONLY owning kind whose `spec_slug` is the real spec slug. Fallback: derive the slug from the `claude/build-<slug>` branch name (`slugFromBuildBranch`). NEVER returns a `pr-<n>` pseudo-slug (a defensive `/^pr-\d+$/` belt re-derives from the branch name if one ever slips through).

> ⚠️ **`pr-resolve` pseudo-slug gotcha (the M4 tests-gate wedge, fixed live 2026-06-29).** A `pr-resolve` owning job stamps `spec_slug = pr-<number>` (e.g. `pr-850`) — it runs against a PR, not a spec; a `fold` job carries an unrelated fold slug. The original gate returned the NEWEST owning job's slug for BOTH resolutions. So whenever the auto-resolver had run last on a branch, `getBranchBuildSuccess` returned `specSlug="pr-850"` — and the M4 tests gate then called `isSpecTestGreenForBranch(ws, "pr-850", branch)`, found NO `spec_test_runs` row for `pr-850`, read `spec-test=pending/red`, and a CLEAN, spec-test-approved PR never auto-merged. Observed live: `claude/build-kpi-review-loop-health-current-state-tolerance` (#850/#841/#847 sat ~10h) — the REAL slug `kpi-review-loop-health-current-state-tolerance` had an `approved`/`auto_pass=1`/`0-fail` run and gated TRUE. The slug-resolution split above is the fix: status may follow `pr-resolve`, but the slug/workspace are pinned to the `build` job (or the branch name), so the per-branch spec-test lookup always uses the real slug.

### Read helpers

- `getLatestPlanJob(workspaceId, goalSlug)` — newest `plan` job for a goal (drives Plan/Re-plan).
- `getLatestJobsBySlug(workspaceId)` — latest job per spec (board per-card status).
- `getPendingFolds(workspaceId)` — specs queued for / mid- a fold-build ([[../specs/fold-build-batching]]).

### `AGENT_JOB_COLUMNS` / `jobSelect` — typed column source-of-truth  *(agent-jobs-typed-column-source-of-truth Phase 1)*

**File:** [[../../../src/lib/agent-jobs-columns]]

```ts
const AGENT_JOB_COLUMNS = ["id","workspace_id","spec_slug","spec_branch", …] as const;
type AgentJobColumn = (typeof AGENT_JOB_COLUMNS)[number];
function jobSelect(...cols: AgentJobColumn[]): string;
```

The **typed source-of-truth for [[../tables/agent_jobs]]' selectable columns** — every reader composing a `.select("…")` string against `agent_jobs` funnels through `jobSelect(...)` so a nonexistent column name is a **tsc error** at authoring time, not a silent-empty 42703 at runtime.

**Why this exists.** Postgres raises **42703** on an unknown column in a SELECT list, but the Supabase JS client swallows it — the reader gets `{ data: null, error: <42703> }` and, if the caller checks only `data`, silently degrades. This bit `scripts/builder-worker.ts`' director-grade lane live: two selects requested a nonexistent `agent_jobs.merge_sha` column, so every enrichment read returned undefined and the repeat-failure logic silently no-op'd (also producing 42703 log noise that looked like a schema-drift incident). Same class chokepoint as [[specs-table]] / [[competitors]] / [[ticket-analyses]]. **Hard rule (new):** a new `.select("<literal>")` on `agent_jobs` MUST compose through `jobSelect(...)`; deliberate raw selects need an inline `// intentional override:` note explaining why.

**agent_jobs has NO `merge_sha` column.** The merge SHA lives on [[../tables/spec_phases]] `merge_sha` / [[../tables/spec_status_history]] — source it there if actually needed. The drift test (`src/lib/agent-jobs-columns.test.ts`) parses `supabase/migrations/*_agent_jobs*.sql`, asserts the constant matches every migration-declared column both ways, and pins the `merge_sha`-is-not-a-column trap so a future re-add of the historic silently-empty select is caught pre-merge. Runs via `npm run test:agent-jobs-columns` — no DB credentials required (migrations are the code-side schema-of-truth).

## Tables written

- [[../tables/agent_jobs]] (inserts `spec-test` rows via `enqueueSpecTestIfDue`; inserts auto-queued `build` rows via `autoQueueUnblockedBy` — [[../specs/spec-blockers]]; inserts `goal-fold` rows via `finalizePromotedGoal` / `reconcileCompletedGoalsToFolded`; flips jobs → `merged` in `reconcileMergedJobs`)
- [[../tables/director_activity]] (`reconcileCompletedGoalsToFolded` writes one `reconciled_completed_goal_folded` row per completed non-parent goal it self-archives — via [[director-activity]] `recordDirectorActivity`)

## Tables read (not written)

- [[../tables/agent_jobs]] (in-flight dedupe, latest-job/plan lookups), [[../tables/spec_test_runs]] (fresh-run dedupe), [[../tables/pending_folds]]
- [[../tables/specs]] + [[../tables/spec_phases]] via [[specs-table]] `getSpec` — the PM-flow reads ([[../specs/retire-md-reads-from-pm-flow]] Phase 2); also `listSpecs(ws, { status: 'folded' | 'deferred' })` in `cancelJobsForArchivedSpecs` to union DB-archived slugs into the FS archive set ([[../specs/cancel-jobs-for-archived-specs-reads-db-fold-not-just-markdown]]). `docs/brain/archive.d/**` via [[brain-roadmap]] `listArchivedSlugs` for the folded-spec gate.

---

> `applyMergedBuildEffects` also fires the per-diff security pass ([[security-agent]] `enqueueSecurityReviewJob`, deduped by merge SHA) on every merged build — [[../specs/security-dependency-agent]] Phase 1.
> `applyMergedBuildEffects` also fires the ship-time backfill detector ([[ship-time-backfill-detector]] `detectAndEscalateShipTimeBackfills`, per-`(spec,script,day)` dedupe) on every merged build — a `scripts/_backfill-*.ts` added by the diff is ledgered in [[../tables/data_op_runs]] and escalated to the CEO inbox if it has no successful `ran` outcome ([[../specs/ship-time-data-backfills-run-and-ledgered-not-silently-dead-code]] Phase 1).

[[../README]] · [[brain-roadmap]] · [[spec-drift]] · [[../tables/agent_jobs]] · [[../tables/spec_test_runs]] · [[../tables/data_op_runs]] · [[../inngest/spec-test-cron]] · [[../specs/spec-test-agent]] · [[../specs/spec-test-on-ship]] · [[../lifecycles/roadmap-build-console]] · [[security-agent]] · [[ship-time-backfill-detector]]
