# Lifecycle: Spec-and-goal branch PM flow + atomic promotion

The end-to-end trace of how a feature moves **authored spec → built on a branch → tested on a preview → promoted to production**, under the **branch-accumulation** model. The build pipeline never puts a half-built spec or a partial goal on `main`: every phase accumulates on a per-spec build branch, the whole spec is tested on its branch preview before it leaves the branch, and a multi-spec goal lands on `main` in **one atomic merge** when (and only when) the whole goal is done and green.

This supersedes the old **"one PR ships one phase, a phase is `shipped` the instant its PR merges to `main`"** model. That model created a deadlock — phase N's build needs phase N-1's code on `main`, but you can't put phase N-1 on `main` before it's tested — and it let production receive a partial spec (phases 1–2 live, 3 still in flight) or a partial goal (spec A live, spec B still building). Branch-accumulation resolves both: code is tested **before** promotion, and promotion is **atomic** per shippable unit (a one-off spec, or a whole goal).

Design + milestones: [[../specs/spec-goal-branch-pm-flow]]. Hierarchy + status semantics: [[../project-management]]. The build console + box worker that drive it: [[roadmap-build-console]].

## The three branch tiers

```
main (production)
  ▲ ATOMIC — one merge per shippable unit (a one-off spec, or a whole goal)
  │
  ├── claude/build-{slug}   ← the SPEC BRANCH: every phase of a spec commits here,
  │     • P1 → P2 → P3 …      one commit(-set) per phase, each built on the prior phase's tip
  │     • the ONLY prefix that gets a Vercel preview (vercel-skip-non-spec-build-refs)
  │     • pre-merge spec-test + security run against that preview
  │     • a ONE-OFF spec (no goal) promotes from here straight to main  ── Gate A ──▶ main
  │
  └── goal/{goal-slug}      ← the GOAL BRANCH: a goal's finished spec branches merge here,
        • one REAL merge commit per spec, in blocked_by (topological) order  ◀── Gate B
        • seeded from origin/main by the goal's FIRST spec
        • accumulates the whole goal; never touches main until the goal is complete
        • when ALL the goal's specs are on it + green  ── Gate C ──▶ main (one atomic merge)
```

- **Spec branch `claude/build-{slug}`** — every phase of a spec builds here as **one commit(-set) per phase**, each phase building on the previous phase's tip (no `main` round-trip between phases). This is the only branch prefix that gets a Vercel preview (`vercel-skip-non-spec-build-refs` whitelists `^claude/build-`; [[../integrations/vercel]], [[../libraries/vercel-project]]). "Phase built" derives from the phase's commit on this branch (`spec_phases.build_sha`) plus the spec-test verdict — **not** a merge to `main`.
- **Goal branch `goal/{goal-slug}`** — seeded from `origin/main` by the goal's FIRST promote-eligible spec. Each `in_testing`-eligible, goal-bound spec branch merges in as **one real merge commit** (not a squash — so the goal branch carries each spec's full history for the atomic main promotion), sequenced by `blocked_by`. The goal branch only accumulates; it never pushes to `main` until the goal is complete.
- **Main / production** — atomic. A **one-off spec** (no goal) merges its spec branch straight to `main` when done + green. A **goal** merges its goal branch to `main` **once**, when every member spec is on it and green — one promotion = the whole goal.

## The three promotion gates

| Gate | What | Driver |
|---|---|---|
| **Gate A** — one-off spec → main | A spec with **no goal** auto-merges its `claude/build-{slug}` branch straight to `main` when promote-eligible. **Guarded to one-off specs only** — a goal-bound branch is HANDED OFF (it must go through Gate B/C, never jump to main here, else it'd ship outside the atomic promotion AND double-stamp). | [[../libraries/github-pr-resolve]] `autoMergeReadyPrs` (goal-bound guard via [[../libraries/agent-jobs]] `resolveGoalSlugForSpec`) → `applyMergedBuildEffects` |
| **Gate B** — spec → goal branch | A goal-bound, promote-eligible spec merges its branch into `goal/{goal-slug}` (created from `main` by the goal's first spec), **sequenced by `blocked_by`** (Kahn topo-sort). Stamps `specs.goal_branch_sha`. Conflicts surface (`409`), never silently drop. Does NOT push to main. | [[../libraries/agent-jobs]] `promoteEligibleSpecsToGoalBranch` → [[../libraries/github-pr-resolve]] `mergeSpecBranchIntoGoalBranch` |
| **Gate C** — atomic goal → main | When every member spec is on the goal branch and green, merge `goal/{goal-slug}` → `main` in **one atomic merge**. Stamps every member phase `shipped`. Respects the parent-goal exemption. | [[../libraries/agent-jobs]] `promoteCompleteGoalsToMain` → [[../libraries/github-pr-resolve]] `mergeGoalBranchIntoMain` → `applyGoalPromotionEffects` |

> **Gate-letter reuse — don't conflate with the auto-ship pipeline's gates.** The auto-ship pipeline ([[roadmap-build-console]] § auto-ship pipeline) also labels its auto-merge-a-ready-PR gate "Gate A" and its auto-fold-a-verified-spec gate "Gate B" ([[../libraries/spec-test-runs]] `autoFoldVerifiedSpecs`). **Gate A is the SAME mechanism in both** — `autoMergeReadyPrs` — it just now carries the goal-bound guard so it only fires for one-off specs. The auto-ship "Gate B (auto-fold)" is a *post-ship* step (shipped → folded) and is unrelated to this flow's Gate B (spec → goal branch). Below, the goal-branch and atomic-promotion gates are always named explicitly (Gate B / Gate C).

## Status flow

```
planned → in_testing → shipped → folded
```

| Status | Means | Where it derives from |
|---|---|---|
| **planned** | Authored + Vale-reviewed, not yet built (or mid-build, no green branch preview) | every phase `planned`/`in_progress`; no full green branch preview yet |
| **in_testing** | **Built + tested on a branch, NOT in production** — every phase carries a `build_sha`, the branch preview's spec-test + security are green | [[../libraries/agent-jobs]] `isSpecPromoteEligible` — accumulation-complete ∧ spec-test-green ∧ security-green (the SAME predicate the board's `applyInTestingOverlay` and the Gate A inline gate read) |
| **shipped** | Promoted to `main` — a one-off spec via Gate A, or a goal-member via the atomic Gate C. Live in prod. | a `main` promotion stamped the phases `shipped` (`applyMergedBuildEffects` one-off / `applyGoalPromotionEffects` goal) |
| **folded** | Post-ship machine spec-test passed → knowledge extracted into permanent brain pages, [[../tables/specs]] row flipped `status='folded'` (preserved) | [[../libraries/spec-test-runs]] `autoFoldVerifiedSpecs` (the auto-ship pipeline's auto-fold gate — see [[roadmap-build-console]]) |

`in_testing` is the load-bearing new state: a spec sits here while it is **complete and green on a branch but not yet on `main`**. It is **derived** ([[../libraries/brain-roadmap]] `SpecStatus`, a slot between `in_progress` and `shipped`), never stored as a phase status — no phase is ever `in_testing`. A built-on-branch phase reads `in_progress` (it has a `build_sha` but no `merge_sha`/`pr` and no `shipped`).

## End-to-end trace

### 1. Author → in_review → Vale → planned

- A feature is authored to `public.specs` + `public.spec_phases` (the authoring chat / Sage / the planner — see [[roadmap-build-console]] § Author). A newly-authored spec lands `in_review`; the build pipeline refuses to dispatch it.
- **Vale** (the [[../specs/spec-review-agent|spec-review agent]], box `spec-review` job) reviews it against the authoring checklist and stamps the durable `specs.vale_pass=true` (`markSpecCardValePassed`). Quality-only — the planned/deferred disposition belongs to Ada.
- Once authored + Vale-passed + every `blocked_by` cleared, the spec is `planned` and eligible to build. The **claim-time build gate** ([[../specs/claim-time-build-gate]], `evaluateClaimTimeBuildGate`) enforces all three at the box's first claim, reading DERIVED status off the brain-roadmap rollup. **Goal-aware blocker clearance** ([[../libraries/agent-jobs]] `resolveGoalSlugForSpec` / `areSpecsGoalMates`): a **goal-mate** blocker clears when it is **on the goal branch** (`isSpecOnGoalBranch` — a goal-mate never ships to main until Gate C), an **external** blocker clears only when **shipped**. This is the fix that stops a goal-mate dependent deadlocking forever.

### 2. Build phases accumulate on the spec branch (one commit per phase)

- The box's `runBuildJob` builds **exactly one phase per session** — the next `planned` phase — and commits it onto `claude/build-{slug}` (created from `main` if absent; a goal-bound fresh branch bases on `origin/goal/{goal-slug}` when that branch already exists, so it builds on goal-mates already landed). Phase N builds on phase N-1's tip; there is **no per-phase PR to `main`** and **no `main` round-trip** between phases.
- Each phase's commit is stamped via [[../libraries/specs-table]] `stampPhaseBuilt(workspace, slug, position, { build_sha })` — recording `spec_phases.build_sha` and moving the phase to `in_progress` (built — NOT shipped). `build_sha` set with `merge_sha`/`pr` null = built-on-branch; it's the "this phase is done building" signal the next-phase advance reads (NOT the main-merge `pr` tag). `build_sha` is the branch-flow replacement for the old per-phase-to-main provenance.
- "Build all" chains: on each phase's commit, the next `planned` phase is queued (built atop the prior phase's code on the same branch) until every phase is built.

### 3. Accumulation gate → preview → pre-merge spec-test + security

- **Accumulation gate** — `isSpecAccumulationComplete` ([[../libraries/specs-table]]) is true only when **every** phase carries a `build_sha` (or is terminal). A spec with an unbuilt phase is held. This single predicate is read by THREE seams so they never disagree on "fully built on branch": the Gate A auto-merge accumulation gate, the M3 pre-merge-test trigger, and `isSpecPromoteEligible`.
- The spec branch gets a **per-build Vercel preview** ([[../specs/per-build-vercel-preview-deploys]]; `claude/build-*` is the only whitelisted prefix). When the LAST phase's preview reaches READY (accumulation complete + `agent_jobs.preview_url` set), [[../libraries/agent-jobs]] `maybeEnqueuePreMergeSpecTestOnAccumulation` fires ONE `kind='spec-test'` job carrying `spec_branch=branch` (so the runner reads the branch's spec body, not `main`'s) and the preview origin in `instructions`. Earlier phases' previews land READY too, but accumulation isn't yet complete → no-op.
- **Spec-test** ([[../specs/spec-test-agent|Vera]]) runs the spec's `## Verification` bullets against the branch preview — non-destructive checks only; mutating checks stay scoped to the test workspace (`is_test`). **Security** runs in parallel against the unmerged diff + the preview origin ([[../libraries/security-agent]] `branch` mode). Both green over the whole spec = the branch is promote-ready.

### 4. `in_testing` / `isSpecPromoteEligible`

`isSpecPromoteEligible(workspace, slug, branch)` ([[../libraries/agent-jobs]]) returns eligible iff ALL THREE hold:
1. **accumulation-complete** (`isSpecAccumulationComplete`),
2. **spec-test green on the branch preview** ([[../libraries/spec-test-runs]] `isSpecTestGreenForBranch` — the latest pre-merge run for `(workspace, slug, branch)` is a clean machine pass),
3. **security green on the branch** ([[../libraries/security-agent]] `isSecurityGreenForBranch` — `completedClean`).

These are the SAME three signals the Gate A auto-merge gate enforces inline AND the SAME predicates `applyInTestingOverlay` derives `in_testing` from — so the board, the auto-merge gate, and this helper never disagree on "is the spec done testing?". Fails CLOSED on the green signals (absent run ⇒ not eligible). An eligible spec reads **`in_testing`** and takes ONE of two promotion paths by goal membership.

### 5a. Goal-bound spec → goal branch (Gate B)

`promoteEligibleSpecsToGoalBranch` ([[../libraries/agent-jobs]]) runs the goal's promote-eligible specs in **topological order by `blocked_by`** (`sequencePromoteCandidates`):

- For each `isSpecPromoteEligible`, goal-bound spec not yet on its goal branch (`goal_branch_sha` unset), merge `claude/build-{slug}` → `goal/{goal-slug}` via the GitHub `/merges` API ([[../libraries/github-pr-resolve]] `mergeSpecBranchIntoGoalBranch` — a real merge commit, API-only/no checkout so it runs from the box worker AND the webhook). The goal's first spec **seeds** the goal branch from `origin/main`.
- On success, stamp `specs.goal_branch_sha = mergeSha` ([[../libraries/specs-table]] `stampSpecGoalBranchSha`) — the durable "on the goal branch" marker (writes NEITHER status NOR `merge_sha`; on-the-goal-branch is NOT shipped).
- One merge per spec (idempotent — stamped specs skip). The goal branch is **never** pushed to `main` here. **Conflicts surface** (`conflicts[]` / `409`), never silently dropped — the caller escalates.

### 5b. Goal complete → atomic goal → main (Gate C)

`promoteCompleteGoalsToMain` ([[../libraries/agent-jobs]]) gates each greenlit goal in order:

1. **parent-goal exemption** — skip a parent ([[../libraries/goals-table]] `isGoalParentExempt`: `goals.is_parent` flag OR has child goals OR no buildable specs). A parent (e.g. [[../goals/ceo-mode|CEO mode]]) has no goal branch; its **sub-goals promote independently**, each via its own Gate C. There is no single atomic parent promotion.
2. **goal-complete** — `goalBranchState(goalSlug).allOnGoalBranch` ([[../libraries/specs-table]]): ≥1 spec AND every member spec stamped with a `goal_branch_sha`.
3. **green** (combination-verified without an extra preview deploy) — every member spec individually `isSpecPromoteEligible` on its own branch (already tested); because each dependent built OFF the goal branch, the integrated whole was compiled together, and the clean atomic land is the final combination check.
4. **promote** — `mergeGoalBranchIntoMain(goalSlug)` ([[../libraries/github-pr-resolve]]) merges `goal/{slug}` → `main` in ONE merge (a real merge commit, so `main` carries the goal's full per-spec history) + deletes the spent goal branch. A **`409` conflict** HOLDS the goal (nothing stamped, left for the owner). Then `applyGoalPromotionEffects(workspace, goalSlug, mergeSha)` — the **ONLY shipped-writer for goal-bound specs** — iterates `goalBranchState.specs` and stamps every member phase `shipped` with the single goal→main merge SHA, flips each member spec `shipped`, and the specs fold per the normal post-ship path.

### 5c. One-off spec (no goal) → main directly (Gate A)

- A spec with **no goal** (`resolveGoalSlugForSpec` → null) doesn't wait for anyone. On `isSpecPromoteEligible`, `autoMergeReadyPrs` squash-merges its `claude/build-{slug}` branch to `main`. `applyMergedBuildEffects` then stamps the **whole spec** shipped: a non-chain multi-phase build with no named phase = a fully-accumulated branch landing in one merge → stamp EVERY non-terminal phase `shipped` (the accumulation gate guarantees the branch only merged fully-built). A chain build still names its phase and ships phase-by-phase; a one-shot (0 phases) records `merged_pr`/`last_merge_sha` on the row.
- One-off specs keep shipping incrementally — only goal-bound work batches.

### 6. Shipped → folded

- Post-promotion the spec is `shipped` and live. Its machine spec-test (now against `main`) runs; on an `approved` verdict with a clean security pass and no open regression, the auto-fold gate ([[../libraries/spec-test-runs]] `autoFoldVerifiedSpecs`) enqueues a fold-build that extracts the spec's knowledge into the permanent brain pages and flips the [[../tables/specs]] row `status='folded'` (preserved). Human QA is advisory and never gates this. See [[roadmap-build-console]] § fold + [[../project-management]] § Folding.

## The Reva atomic deploy-watch — escalate, not revert

A promotion to `main` triggers a Vercel production deploy, which opens a Reva deploy-watch ([[../tables/deploy_watches]], [[../libraries/deploy-guardian]]) over the canary window. **Two deploy shapes:**

- **Per-spec** — a `claude/<slug>` build branch squash-merged to `main` (Gate A, one-off specs). On a `regressed` verdict Reva **restores known-good FAST** (`revertDeployMerge` auto-revert of the offending squash) + escalates — reverting one spec is cheap.
- **Atomic** — a `goal/<slug>` branch promoted to `main` in one merge (Gate C, carrying many specs). The watch is opened by `promoteCompleteGoalsToMain` passing `workspaceId` + the goal slug + `isAtomic:true` to `openDeployWatch`, and the row is stamped `deploy_watches.is_atomic=true`. A regression here **ESCALATES, never auto-reverts**: rolling back a whole tested goal on a regression bar tuned for tiny per-phase diffs would be a false-revert of many specs' work, so a **human decides** (revert the goal merge, hotfix-forward, or accept). The promotion was atomic and tested-before-merge; the response to a regression is a human decision, not an automatic un-ship of a whole goal.

Migration `20260730120000_deploy_watches_is_atomic.sql` adds the `is_atomic` column; `openDeployWatch` tolerates the pre-migration schema (a `42703` on the unknown column retries without it).

## M6 subsumes the preview-test-promote-pipeline's board/timeline milestone

The branch-flow's **M6** (`in-testing-status-and-board-for-branch-flow`) **subsumes** the preview-test-promote-pipeline's **M5** (`in-testing-board-and-lifecycle-timeline`): both derive the `in_testing` board status and surface branch state on the roadmap board + the lifecycle timeline. The branch-flow version is canonical — it derives `in_testing` from **spec/goal-branch membership + spec-test green** (not just "preview built but tests pending") and adds the goal-accumulation view. It is built once here, not twice. The board surfaces ([[../libraries/brain-roadmap]] M6):

- **Per-spec timeline** — `SpecCard.onGoalBranch` / `goalBranchSha` feed a `BranchPosition` timeline (built on branch → in testing → on goal branch → promoted to main). A one-off spec leaves them false (it promotes straight to main).
- **Per-goal accumulation** — `GoalCard.accumulation` (`deriveGoalAccumulation`) = `{ onGoalBranch, totalSpecs, allOnGoalBranch, exempt, exemptReason }`. `allOnGoalBranch` ⇒ the **"⬆ ready to promote"** badge; `exempt` ⇒ the parent-goal "sub-goals promote independently" note (mirrors `isGoalParentExempt` from already-loaded rows, no extra DB reads).

The preview-test-promote-pipeline's earlier pieces (per-build previews, spec-test-on-preview, the `in_testing` status slot, promote-on-green) are reused as the substrate.

## Why this resolves the old model's failures

| Old model (per-phase-to-main) | Branch-accumulation model |
|---|---|
| Phase N's build needs phase N-1 on `main`, but N-1 can't go to `main` untested → **deadlock** | Phase N builds on phase N-1's commit on the **same spec branch** — no `main` round-trip |
| A spec is `shipped` the instant its phase PR merges → **partial spec in prod** | A spec is `shipped` only when the **whole** spec promotes (Gate A whole-spec stamp / atomic Gate C) — never partial |
| A goal's specs merge to `main` one at a time → **partial goal in prod** | The goal lands in **one atomic merge** (Gate C) when the whole goal is done + green |
| Phase provenance = `(pr, merge_sha)` of a `main` merge | Phase provenance = `build_sha` on the spec branch (built); `pr`/`merge_sha`/`shipped` reserved for the promotion stamp |
| Ada keys "started/partially-built" on the `pr` tag | Ada keys on `branchBuiltCount` (`build_sha` or shipped) — the `pr` tag is 0 for a whole branch-flow spec until promotion |
| Reva blindly reverts any regression | One-off spec → revert; **atomic goal (`is_atomic`) → escalate, not revert** |

## Status / open work

**Shipped (2026-06-28):** the branch-accumulation flow is implemented + brain-documented end-to-end — M1 phases-commit-to-`claude/build-{slug}` (one commit per phase); M2 `stampPhaseBuilt`/`build_sha` provenance + the accumulation gate ([[../libraries/specs-table]] `isSpecAccumulationComplete`, read by all three seams); M3 the pre-merge spec-test trigger (`maybeEnqueuePreMergeSpecTestOnAccumulation`) + `isSpecPromoteEligible`; M4 spec→goal-branch (Gate B, `promoteEligibleSpecsToGoalBranch` / `mergeSpecBranchIntoGoalBranch`, `goal_branch_sha`, `blocked_by`-sequenced, goal-mate blocker clearance); M5 atomic goal→main (Gate C, `promoteCompleteGoalsToMain` / `mergeGoalBranchIntoMain` / `applyGoalPromotionEffects` the sole goal shipped-writer, parent-goal exemption via `isGoalParentExempt` + `goals.is_parent`); M6 board/timeline surfacing (`SpecCard.onGoalBranch`, `BranchPosition`, `GoalCard.accumulation` / `deriveGoalAccumulation`, the "⬆ ready to promote" badge). The audit aligned all agents: Gate A merges one-off specs ONLY (goal-bound → Gate B/C, no double-stamp), Reva's `is_atomic` watch escalates-not-reverts a whole goal, and Ada's groom/init/fix-escort lanes gate on `branchBuiltCount` (not the pr-tag `provenanceShippedCount`). Migrations: `20260726120000_spec_phases_build_sha.sql`, `20260730120000_deploy_watches_is_atomic.sql` (+ the `goals.is_parent` migration).

**Substrate reused (already shipped):** per-build Vercel previews scoped to `claude/build-*` ([[../specs/per-build-vercel-preview-deploys]], `vercel-skip-non-spec-build-refs`); pre-merge spec-test + security on the branch preview ([[../specs/spec-test-on-preview-pre-merge]], [[../specs/security-test-on-preview-pre-merge]]); the `in_testing` derived status slot (`in-testing-derived-status`); one-phase-per-build-session; the auto-ship pipeline's auto-merge (the Gate A merge primitive) + auto-fold gates ([[../specs/auto-ship-pipeline]]); the claim-time build gate ([[../specs/claim-time-build-gate]]) + Vale spec-review ([[../specs/spec-review-agent]]).

**Known gaps / not yet shipped:** none material to the flow — the M1–M6 chain + the audit alignment are in place. M6 subsumes the preview-test-promote-pipeline's M5 board/timeline milestone (intentionally not built twice).

**Open questions:** None.

## Related

[[../specs/spec-goal-branch-pm-flow]] · [[../project-management]] · [[roadmap-build-console]] · [[../tables/spec_phases]] · [[../tables/specs]] · [[../tables/goals]] · [[../tables/deploy_watches]] · [[../libraries/agent-jobs]] · [[../libraries/specs-table]] · [[../libraries/github-pr-resolve]] · [[../libraries/spec-test-runs]] · [[../libraries/security-agent]] · [[../libraries/deploy-guardian]] · [[../libraries/brain-roadmap]] · [[../libraries/platform-director]] · [[../integrations/vercel]] · [[../specs/spec-test-agent]] · [[../specs/spec-review-agent]] · [[../specs/claim-time-build-gate]] · [[../specs/auto-ship-pipeline]] · [[../recipes/build-box-setup]]
