# phantom-ship-detector

> **Standing predeploy audit that surfaces phases marked `shipped` whose real code isn't on the target branch** ([[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]] Phase 3).

Complements the per-slug [[spec-audit]] (origin/main-only, `spec_status_history`-driven). Where `spec-audit` re-stamps a spec's phase provenance from the merge subject on `origin/main`, this detector is a whole-board scan that catches the class `spec-audit` can't: a phase flipped `shipped` by a mechanism that BYPASSED the merge hook — e.g. the pre-P2 `reconcileMergedSpecPhases` blanket-stamp that copied a sibling's `merge_sha` onto every un-shipped phase with zero code check (the v3 `factor-rollup-sdk-with-significance-gate` incident the spec cites, where P2/P3 read shipped though `getFactorRollup` was never written).

## What it does

For every ACTIVE (non-folded) spec, for every phase with `status='shipped'`, the detector resolves the target branch and runs the phase's grep checks against that branch HEAD via [[specs-table]] `verifyPhaseAccumulatedOnBranch`. A phase whose verifier reports `accumulated:false` is a PHANTOM — reported.

**Target branch per spec:**
- Goal-bound spec (has `milestone_id`) → `origin/goal/{goal-slug}` (M4 merges the spec's build branch onto its goal branch and stays there until M5's atomic goal→main promotion).
- One-off spec → `origin/main` (ships direct to main).

Resolver: `branchForGoal(goalSlug: string | null)` (pure) + `resolvePhantomShipTargetBranch(workspaceId, slug)` (DB-backed — calls [[agent-jobs]] `resolveGoalSlugForSpec`).

## Exports

- **`branchForGoal(goalSlug: string | null)`** → `"origin/goal/{slug}"` when goal-bound, `"origin/main"` otherwise. Pure — no I/O. The unit-testable seam under the DB-backed resolver.
- **`resolvePhantomShipTargetBranch(workspaceId, slug)`** → the DB-backed resolver (delegates the goal-slug lookup to [[agent-jobs]] `resolveGoalSlugForSpec` and returns `branchForGoal` of it).
- **`detectPhantomShippedPhases(deps?)`** → `PhantomShipReport` with `{ scanned, specsScanned, workspacesScanned, phantoms: [{ workspaceId, slug, position, branch, reason }] }`. Enumerates every workspace in `public.specs`, lists its ACTIVE specs via [[specs-table]] `listSpecs({ scope: 'active' })` (folded specs are excluded — they're archived, not gate-eligible), and per shipped phase calls `verifyPhaseAccumulatedOnBranch(workspaceId, slug, position, targetBranch)`. `deps` (a `DetectorDeps` DI point) lets tests plug in fixture workspaces / specs / branch resolvers / a mock verifier without touching git or Supabase.
- **`defaultDetectorDeps`** — the production dep set (real Supabase enumeration + `verifyPhaseAccumulatedOnBranch`'s default git-grep executor).

## Where it runs

- **Predeploy gate** — chained into `package.json`'s `predeploy` chain as `check:phantom-shipped-phases` (last in the sequence, so cheaper static analyses fail-fast first). Runs via `scripts/_check-phantom-shipped-phases.ts`.
- The CLI wrapper **gracefully SKIPS** when `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_URL` are absent (a CI-lite `npm i` context has no DB creds — forcing a red there would break every unrelated PR without adding signal). Runs where the DB IS reachable — the box worker's predeploy gate before pushing.

## What it refuses to do

- **No mutations.** The wedge is that mutations have ALREADY happened (a phase was flipped `shipped` without code); surfacing the offenders is the fix, not un-shipping them. That decision belongs to a human / a separate remediation lane.
- **No tsc / build / http / db_probe / unit_test execution.** The detector only asks the verifier for GREP checks — those are cheap and safe to run against a branch ref via `git grep`. The heavier machinery is `spec-check-runner`'s job at spec-test time, not this fast standing audit.
- **No branch-content fabrication.** A missing branch (fetch drift) reads as fail-closed via `verifyPhaseAccumulatedOnBranch` and surfaces as a phantom with a git-grep-error reason — the detector doesn't guess "probably fine."

## Related

- [[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]] — the spec (P1 = verifier + gate rewrite; P2 = reconciler guard; P3 = this detector)
- [[specs-table]] — `verifyPhaseAccumulatedOnBranch`, `isSpecAccumulationComplete`
- [[agent-jobs]] — `resolveGoalSlugForSpec`, `reconcileMergedSpecPhases` (the reconciler this detector backstops)
- [[spec-audit]] — the per-slug origin/main-only audit this detector complements
- [[spec-check-runner]] — the deterministic runner whose grep hardening `verifyPhaseAccumulatedOnBranch` mirrors
