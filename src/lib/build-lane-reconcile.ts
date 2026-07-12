/**
 * builder-self-heals-stale-build-branch Phase 1 — reconciliation strategy for a build branch
 * relative to origin/main.  Pure — no I/O.  Tested by [[../build-lane-reconcile.test.ts]].
 *
 * The build lane MUST advance a branch's local base to CONTAIN origin/main BEFORE running
 * repo-wide checks (tsc, `check:table-refs-have-migrations`) — those checks assume main as the
 * reference tree, and a stale base whose gap main already closed would otherwise fail a
 * non-real regression.
 *
 * A `git rebase origin/main` linearly replays the branch's commits and SPURIOUSLY conflicts on
 * NON-LINEAR history — the goal-member case named in the spec (a member branch inherits merge
 * commits from the goal branch, which itself carries a main reconciliation, so rebase replays
 * the merges and hits the same conflict every retry) — even though `git merge origin/main`
 * applies CLEAN.  Confirmed 2026-07-11: director-chat-in-leash-execution and machine-declared-
 * verification-and-deterministic-spec-test-runner both parked at needs_attention after the
 * escort/groom loop guard escalated a self-healable staleness to the CEO inbox.
 *
 * So the primary strategy is MERGE for anything non-linear, REBASE only for a truly-linear
 * branch — `chooseReconcile` encodes that choice.  When the primary conflicts, `chooseReconcileFallback`
 * picks a fallback: RECREATE-FRESH when the branch carries no built work AND was never pushed
 * to origin (its local commits are throwaway attempts from an earlier failed session — safe to
 * reset onto the correct base), otherwise the OTHER reconcile approach (merge ↔ rebase).  Only
 * when the fallback ALSO conflicts is the divergence a real semantic overlap that must park
 * needs_attention (Phase 2 names the conflicting files on that park).
 *
 * Invariants: never force-push, never touch main, never drop BUILT commits (a phase with a
 * `build_sha` is durable state — `hasBuiltWork` gates `recreate-fresh` off in the fallback).
 */

export type ReconcileStrategy =
  | "skip"            // origin/main is already an ancestor of HEAD — nothing to reconcile
  | "merge"           // MERGE origin/main INTO the branch (safe for non-linear; no commit rewrite)
  | "rebase"          // REBASE branch onto origin/main (linear replay; clean history for a linear branch)
  | "recreate-fresh"; // reset the branch to the correct base (safe only when no built work is lost)

export interface ReconcileInput {
  /** `git merge-base --is-ancestor origin/main HEAD` → HEAD already contains main.  When true,
   *  no reconcile is needed; the caller may skip merge/rebase entirely. */
  headContainsMain: boolean;
  /** `git log --merges origin/main..HEAD` non-empty → the branch has merge commits since it
   *  diverged from main.  A goal-member branch inherits merge commits from the goal branch's
   *  reconciliation with main; a rebase would try to replay those merges and spuriously conflict. */
  hasMergeCommits: boolean;
  /** Any `spec_phases` row has a non-null `build_sha` — the branch carries a BUILT phase (its
   *  commit is durable state, never dropped).  This gates `recreate-fresh` off in the fallback. */
  hasBuiltWork: boolean;
  /** `origin/<branch>` exists (branch was pushed at least once).  Recreate-fresh would rewrite
   *  the remote → forbidden when true. */
  branchOnRemote: boolean;
}

/**
 * Primary reconciliation choice for a build branch's base advance.
 *
 * - `skip` when the branch already contains origin/main (no-op).
 * - `merge` when the branch has merge commits (non-linear history) — MERGE is the safe default;
 *   REBASE would replay the inherited merges and spuriously conflict on the same files every
 *   retry.  This is the 2026-07-11 director-chat / ceo-org-control-tower shape the spec pins.
 * - `rebase` for a truly-linear branch (no merge commits since divergence) — a clean linear
 *   replay produces the tidiest history.  A merge would work too but leaves a merge commit
 *   the spec branch doesn't need.
 */
export function chooseReconcile(input: ReconcileInput): ReconcileStrategy {
  if (input.headContainsMain) return "skip";
  if (input.hasMergeCommits) return "merge";
  return "rebase";
}

/**
 * Fallback reconciliation when the primary strategy conflicts.
 *
 * - `skip` mirrors the primary when `headContainsMain` (defensive; caller should never call the
 *   fallback in that case, but a wrong call is a no-op).
 * - `recreate-fresh` when the branch carries NO built work AND is NOT on origin — its commits
 *   are throwaway attempts from an earlier failed session; reset onto the correct base loses
 *   nothing.  This is the director-chat-in-leash-execution case named in the spec: box-local
 *   branch, zero built work, human could not reset it remotely.
 * - Otherwise flip the primary strategy: MERGE ↔ REBASE.  Only when the flipped attempt ALSO
 *   conflicts is the divergence semantic (Phase 2's job to park with the conflicting files).
 *
 * `hasBuiltWork` is the HARD gate on `recreate-fresh` — a phase's committed `build_sha` is
 * durable state the fallback must never drop.
 */
export function chooseReconcileFallback(input: ReconcileInput): ReconcileStrategy {
  if (input.headContainsMain) return "skip";
  if (!input.hasBuiltWork && !input.branchOnRemote) return "recreate-fresh";
  return input.hasMergeCommits ? "rebase" : "merge";
}
