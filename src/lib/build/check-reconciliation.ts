/**
 * check-reconciliation — self-heal a stale/over-precise `expect: 'present'` grep check on the
 * build branch BEFORE the phase-accumulation verify path defers the PR and burns the redrive
 * budget (build-verify-self-heals-stale-grep-checks-before-deferring Phase 1).
 *
 * The wedge (see the spec's § Why): a phase's grep check pins an EXACT literal that the spec
 * author guessed BEFORE the code existed. The builder routinely ships functionally-correct
 * code under a different literal — a renamed symbol (`upsertColdScalerCohort` →
 * `provisionColdScalerCohort`), a case/form difference (`IS NULL` vs `is null`), a reworded
 * token (`quant-desk` vs `Quant-desk`). Phase-accumulation verification then git-greps the
 * stale literal, finds no match, marks the phase unverified, and parks the COMPLETED build
 * with a DEFERRED PR — a false negative where the code is genuinely present.
 *
 * `reconcileStaleGrepCheck` is called on each failing `expect: 'present'` grep check BEFORE
 * defer. Two ordered steps:
 *
 *   STEP A (deterministic, cheap): re-run the grep case-insensitively + whitespace-tolerantly
 *     against the same path on the branch. If it now matches, the ONLY drift is case /
 *     whitespace — repoint the pattern to the actually-present casing.
 *
 *   STEP B (bounded judge, only if A misses): read the check's `description` (its INTENT) +
 *     the phase's branch DIFF for `params.path`. A bounded box-side judge PROPOSES a literal
 *     it thinks satisfies the intent. A CONFIDENT proposal — the judge returned a non-null
 *     literal that ALSO passes the runner's real deterministic grep on the branch — is now
 *     AUTO-APPLIED (step='judge_repoint_auto_applied'): the caller repoints the pattern via
 *     `upsertPhaseChecks` and the phase verifies on that same deterministic grep. The
 *     deterministic grep IS the safety gate — a proposal that doesn't actually match the
 *     branch never lands. A judge that declines (null literal) or a proposal that fails the
 *     final grep falls through to step C — see below. The residual prompt-injection risk (a
 *     crafted diff steers the judge to an unrelated but present literal) is bounded by (a)
 *     the `maxReconciliationsPerBuild` cap and (b) the `check_reconciled` director_activity
 *     audit surface that lands EVERY repoint on the CEO's build card — never silent (see
 *     [[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 1).
 *
 *   STEP C (moved-symbol fallback, only if B misses at the check's path): the check's
 *     declared `params.path` may be wrong because the symbol moved to a different file. Load
 *     the WHOLE phase branch diff (all changed files) and ask a bounded whole-diff judge for
 *     the intent's literal + the file that carries it. If the judge returns a literal + a
 *     DIFFERENT file AND the runner's deterministic grep of {literal, newFile} passes, the
 *     caller repoints BOTH `params.pattern` AND `params.path` via `upsertPhaseChecks`
 *     (step='judge_repoint_moved_symbol'). Same safety gate + cap + audit as step B (the
 *     audit rationale contains `moved_symbol`, and the row surfaces `old_path` + `new_path`
 *     so the CEO sees the file move too). Closes the false-negative wedge where the spec
 *     author guessed the wrong file for a symbol
 *     ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2).
 *
 * INVARIANTS (mirror the spec's guardrails):
 *   1. `expect: 'present'` ONLY. An `expect: 'absent'` miss is a different, real signal
 *      (the code SHOULDN'T be there and IS) — never reconcile it.
 *   2. Every repoint (step A OR step B) MUST still pass a real deterministic grep of the new
 *      pattern before it lands. The final grep is the safety gate — no bypass, no phantom-ship.
 *   3. A judge that declines OR a judge whose candidate fails the final deterministic grep
 *      NEVER auto-reconciles — the check surfaces as unhealed and the caller defers as before.
 *   4. Every dep is injectable (grep / diff / judge / upsert / real-grep) so unit tests drive
 *      policy without touching shell/DB/network.
 *
 * See docs/brain/libraries/check-reconciliation.md for the full flow + audit contract.
 */
import { spawn } from "node:child_process";
import { errText } from "@/lib/error-text";
import type { GrepCheckParams } from "@/lib/spec-phase-checks-table";

export interface FailingGrepCheck {
  /** phase_id (spec_phases.id) — target for upsertPhaseChecks on a successful reconcile. */
  phaseId: string;
  /** phase position (1-based) — carried for audit/logging only. */
  phasePosition: number;
  /** check position within the phase (spec_phase_checks.position) — target for upsert. */
  checkPosition: number;
  /** The check's `description` — the INTENT the judge reads in step B. */
  description: string;
  /** The original grep params that failed (pattern, path, expect). expect must be 'present'. */
  params: GrepCheckParams;
}

export interface ReconcileDeps {
  /**
   * STEP A: run `params.pattern` case-insensitively + whitespace-tolerantly on `branchRef`
   * against `params.path`. Returns the ACTUAL literal that matched (so the pattern can be
   * repointed to the present casing) or null on miss / harness error.
   */
  normalizedGrep: (args: {
    branchRef: string;
    repoRoot: string;
    params: GrepCheckParams;
  }) => Promise<{ matchedLiteral: string | null; evidence: string }>;
  /**
   * Read the phase's branch DIFF for `path` — the input the judge reads. Bounded so a
   * pathological diff can't blow the judge's context. Empty string on read failure.
   */
  loadPhaseDiff: (args: { branchRef: string; repoRoot: string; path: string }) => Promise<string>;
  /**
   * STEP B: bounded box-side judge — reads {description, oldPattern, path, diff} and returns
   * the exact literal present in the diff that satisfies the described intent under a
   * DIFFERENT wording, or null if the intent is genuinely NOT met. Bounded max_tokens; a
   * parse/API failure resolves to null (fail-closed → defer stays intact).
   */
  intentJudge: (input: {
    description: string;
    oldPattern: string;
    path: string;
    diff: string;
  }) => Promise<{ literal: string | null; rationale: string }>;
  /**
   * The FINAL DETERMINISTIC gate — run the runner's grep exactly as it will run post-repoint,
   * so a proposal that doesn't ACTUALLY match on the branch never lands. Same executor the
   * runner uses; injected so tests drive the whole policy without a spawn.
   */
  runDeterministicGrep: (args: {
    branchRef: string;
    repoRoot: string;
    params: GrepCheckParams;
  }) => Promise<{ ok: boolean; evidence: string }>;
  /**
   * STEP C (moved-symbol fallback): load the ENTIRE phase branch diff (all changed files, not
   * just `params.path`). Only invoked when the per-path judge (step B) declines — the check's
   * declared path may be wrong because the symbol moved to a DIFFERENT file. Bounded so a
   * pathological diff can't blow the judge's context. Returns "" on read failure.
   * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
   */
  loadFullPhaseDiff: (args: { branchRef: string; repoRoot: string }) => Promise<string>;
  /**
   * STEP C (moved-symbol judge): reads {description, oldPattern, oldPath, diff (whole phase
   * diff, multi-file)} and returns the literal + the file path present in the diff that
   * satisfies the described intent — a symbol that MOVED to a different file. `file` MUST be
   * a path present in the diff and MUST NOT equal `oldPath` (or the caller falls through to
   * the "not moved" defer path). Fail-closed on API/parse error → `{literal: null, file:
   * null}` so a broken judge never masks a real code-missing failure.
   */
  intentJudgeMovedSymbol: (input: {
    description: string;
    oldPattern: string;
    oldPath: string;
    diff: string;
  }) => Promise<{ literal: string | null; file: string | null; rationale: string }>;
}

export interface ReconcileArgs {
  check: FailingGrepCheck;
  branchRef: string;
  repoRoot: string;
  deps: ReconcileDeps;
}

export type ReconcileOutcome =
  | {
      reconciled: true;
      newPattern: string;
      /**
       * When set, the check's `params.path` moved too — the caller MUST upsert BOTH
       * `params.pattern` (→ `newPattern`) AND `params.path` (→ `newPath`) so the next
       * verify pass greps the correct file. Only set for `step='judge_repoint_moved_symbol'`
       * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2).
       */
      newPath?: string;
      /**
       * 'normalized_case' — step A (deterministic case/whitespace re-match).
       * 'judge_repoint_auto_applied' — step B: the bounded judge returned a literal
       *   AND the runner's real deterministic grep of that literal on the branch
       *   passed. The deterministic grep is the safety gate; a proposal that
       *   doesn't ACTUALLY match never lands. Every judge repoint is surfaced on
       *   the CEO-facing `check_reconciled` director_activity feed
       *   ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 1).
       * 'judge_repoint_moved_symbol' — step C: the check's declared path was wrong
       *   (symbol moved to a different file). The whole-diff judge proposed a literal
       *   + a DIFFERENT file; the runner's deterministic grep of {literal, newFile}
       *   passed. Caller repoints BOTH pattern AND path via upsertPhaseChecks
       *   ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2).
       */
      step:
        | "normalized_case"
        | "judge_repoint_auto_applied"
        | "judge_repoint_moved_symbol";
      rationale: string;
      evidence: string;
    }
  | {
      reconciled: false;
      /** 'not_present_grep' | 'no_normalized_match' | 'judge_declined' | 'proposal_did_not_match' | 'harness_error'. */
      reason: string;
      evidence?: string;
    };

/**
 * Reconcile ONE failing `expect: 'present'` grep check against the branch.
 *
 * Returns `{ reconciled: true, newPattern }` when the branch genuinely carries a literal that
 * satisfies the check's intent — the caller repoints the pattern via `upsertPhaseChecks` and
 * re-runs the deterministic grep. Returns `{ reconciled: false, reason }` otherwise — the
 * caller defers/escalates unchanged (a real code-missing signal must NEVER be masked).
 */
export async function reconcileStaleGrepCheck(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const { check, branchRef, repoRoot, deps } = args;
  if (check.params.expect !== "present") {
    return {
      reconciled: false,
      reason:
        "not_present_grep — expect='absent' misses are a real signal (code shouldn't be there and is), never reconciled",
    };
  }
  // STEP A — normalized re-match. Case + whitespace drift is the vast majority of the wedge and
  // is cheap to prove deterministically, no judge needed.
  let stepAEvidence = "";
  try {
    const a = await deps.normalizedGrep({ branchRef, repoRoot, params: check.params });
    stepAEvidence = a.evidence;
    if (a.matchedLiteral && a.matchedLiteral.trim()) {
      const candidatePattern = a.matchedLiteral;
      // Even a step-A hit MUST pass the runner's deterministic grep — same gate the phase
      // uses. This closes the "normalized match but the real grep still fails" edge (e.g. the
      // matched literal contains regex metacharacters that break the runner).
      const finalCheck = await deps.runDeterministicGrep({
        branchRef,
        repoRoot,
        params: { ...check.params, pattern: candidatePattern },
      });
      if (finalCheck.ok) {
        return {
          reconciled: true,
          newPattern: candidatePattern,
          step: "normalized_case",
          rationale: `case/whitespace drift only — repointed to present literal '${candidatePattern}'`,
          evidence: `${a.evidence}; deterministic re-grep of new pattern: ${finalCheck.evidence}`,
        };
      }
      // Fall through to step B if the normalized-hit literal doesn't survive the final grep.
    }
  } catch (e) {
    stepAEvidence = `normalizedGrep threw: ${errText(e)}`;
    // fall through — step B may still succeed.
  }

  // STEP B — bounded judge over the phase's branch DIFF for the check's path.
  const path = check.params.path ?? ".";
  let diff = "";
  try {
    diff = await deps.loadPhaseDiff({ branchRef, repoRoot, path });
  } catch (e) {
    return {
      reconciled: false,
      reason: "harness_error — could not load phase diff for judge",
      evidence: `loadPhaseDiff threw: ${errText(e)}; stepA: ${stepAEvidence}`,
    };
  }
  if (!diff || !diff.trim()) {
    return {
      reconciled: false,
      reason: "no_normalized_match — step A missed and no diff to judge",
      evidence: `stepA: ${stepAEvidence}; loadPhaseDiff returned empty for '${path}'`,
    };
  }

  let judged: { literal: string | null; rationale: string };
  try {
    judged = await deps.intentJudge({
      description: check.description,
      oldPattern: check.params.pattern,
      path,
      diff,
    });
  } catch (e) {
    return {
      reconciled: false,
      reason: "harness_error — intent judge threw",
      evidence: `intentJudge threw: ${errText(e)}; stepA: ${stepAEvidence}`,
    };
  }
  if (!judged.literal || !judged.literal.trim()) {
    // The per-path judge declined — the symbol may have MOVED to a different file. Fall
    // through to step C (whole-diff moved-symbol) before deferring.
    return await tryMovedSymbolReconcile({
      check,
      branchRef,
      repoRoot,
      deps,
      oldPath: path,
      stepAEvidence,
      perPathJudgeRationale: judged.rationale || "(none)",
      perPathJudgeDeclined: true,
    });
  }

  const proposedPattern = judged.literal;
  // Step B AUTO-APPLIES a confident judge proposal now: on a non-null literal
  // whose deterministic re-grep on the branch passes, repoint the pattern (the
  // CALLER upserts params.pattern via `upsertPhaseChecks` on our `reconciled:
  // true` return). The deterministic grep IS the safety gate — a proposal that
  // doesn't actually match the branch never lands. This closes the false-negative
  // wedge that used to park real, fully-built specs (renamed symbol → hand
  // repoint) — see
  // [[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 1.
  //
  // The residual prompt-injection risk (a crafted diff steers the judge to an
  // unrelated but present literal that DOES grep on the branch) is bounded by:
  //   (a) the `maxReconciliationsPerBuild` cap in `reconcileFailingGrepChecksForSpec`
  //       — a pathological spec whose EVERY grep check is stale can't silently pass;
  //   (b) the `check_reconciled` director_activity audit row emitted by
  //       `defaultAuditReconciliation` for EVERY repoint — every auto-correction is
  //       surfaced on the CEO's build card, never silent. A mis-guessed spec can't
  //       hide behind the reconciler.
  //
  // A judge that returns null OR a proposal whose final grep fails still defers/
  // escalates unchanged — a real code-missing signal is never masked.
  let finalGrepEvidence = "";
  try {
    const finalCheck = await deps.runDeterministicGrep({
      branchRef,
      repoRoot,
      params: { ...check.params, pattern: proposedPattern },
    });
    finalGrepEvidence = finalCheck.evidence;
    if (finalCheck.ok) {
      return {
        reconciled: true,
        newPattern: proposedPattern,
        step: "judge_repoint_auto_applied",
        rationale: `judge_repoint_auto_applied — bounded intent judge mapped '${check.params.pattern}' → '${proposedPattern}' (${judged.rationale || "no rationale"}); deterministic grep of the new literal passes on the branch`,
        evidence: `judge proposed '${proposedPattern}' rationale: ${judged.rationale}; deterministic re-grep of new pattern: ${finalGrepEvidence}; stepA: ${stepAEvidence}`,
      };
    }
  } catch (e) {
    finalGrepEvidence = `runDeterministicGrep threw: ${errText(e)}`;
  }
  // Per-path judge proposed a literal but the deterministic grep at `path` failed. The
  // symbol may have MOVED to a different file (the proposed literal exists elsewhere in
  // the diff). Fall through to step C before deferring.
  return await tryMovedSymbolReconcile({
    check,
    branchRef,
    repoRoot,
    deps,
    oldPath: path,
    stepAEvidence,
    perPathJudgeRationale: `perPath judge proposed '${proposedPattern}' but final grep at '${path}' failed: ${finalGrepEvidence || "(no evidence)"}; rationale: ${judged.rationale}`,
    perPathJudgeDeclined: false,
  });
}

/**
 * Step C — moved-symbol reconcile. The check's declared `params.path` was wrong: the symbol
 * moved to a different file. Load the WHOLE phase diff, ask the whole-diff judge for the
 * literal + the file that carries it, then run the runner's deterministic grep at the NEW
 * path. On pass, return `reconciled: true` with `newPath` set so the caller upserts BOTH
 * `params.pattern` AND `params.path`; on fail, the caller defers as before.
 *
 * The deterministic grep at the new path is the safety gate — a whole-diff judge proposal
 * that doesn't actually match on the branch never lands. Same residual prompt-injection
 * mitigations as step B (per-build cap + `check_reconciled` audit surface).
 * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
 */
async function tryMovedSymbolReconcile(input: {
  check: FailingGrepCheck;
  branchRef: string;
  repoRoot: string;
  deps: ReconcileDeps;
  oldPath: string;
  stepAEvidence: string;
  perPathJudgeRationale: string;
  perPathJudgeDeclined: boolean;
}): Promise<ReconcileOutcome> {
  const { check, branchRef, repoRoot, deps, oldPath, stepAEvidence, perPathJudgeRationale, perPathJudgeDeclined } = input;
  const perPathTag = perPathJudgeDeclined ? "judge_declined_at_path" : "proposal_did_not_match_at_path";
  let fullDiff = "";
  try {
    fullDiff = await deps.loadFullPhaseDiff({ branchRef, repoRoot });
  } catch (e) {
    return {
      reconciled: false,
      reason: `${perPathTag} + harness_error — could not load full phase diff for moved-symbol judge`,
      evidence: `loadFullPhaseDiff threw: ${errText(e)}; perPath: ${perPathJudgeRationale}; stepA: ${stepAEvidence}`,
    };
  }
  if (!fullDiff || !fullDiff.trim()) {
    return {
      reconciled: false,
      reason: perPathJudgeDeclined
        ? "judge_declined — per-path judge declined and full phase diff is empty (nothing to search for a moved symbol)"
        : "proposal_did_not_match — per-path proposal failed and full phase diff is empty (no other files to search for a moved symbol)",
      evidence: `perPath: ${perPathJudgeRationale}; loadFullPhaseDiff returned empty; stepA: ${stepAEvidence}`,
    };
  }

  let movedJudged: { literal: string | null; file: string | null; rationale: string };
  try {
    movedJudged = await deps.intentJudgeMovedSymbol({
      description: check.description,
      oldPattern: check.params.pattern,
      oldPath,
      diff: fullDiff,
    });
  } catch (e) {
    return {
      reconciled: false,
      reason: `${perPathTag} + harness_error — moved-symbol judge threw`,
      evidence: `intentJudgeMovedSymbol threw: ${errText(e)}; perPath: ${perPathJudgeRationale}; stepA: ${stepAEvidence}`,
    };
  }
  const proposedLiteral = movedJudged.literal?.trim() || "";
  const proposedFile = movedJudged.file?.trim() || "";
  if (!proposedLiteral || !proposedFile) {
    return {
      reconciled: false,
      reason: perPathJudgeDeclined
        ? "judge_declined — per-path judge declined and whole-diff moved-symbol judge also declined"
        : "proposal_did_not_match — per-path proposal failed and whole-diff moved-symbol judge did not find the intent under a different file",
      evidence: `perPath: ${perPathJudgeRationale}; moved-symbol rationale: ${movedJudged.rationale || "(none)"}; stepA: ${stepAEvidence}`,
    };
  }
  if (proposedFile === oldPath) {
    // The whole-diff judge pointed back at the same path — the per-path judge already
    // covered that; nothing new to try.
    return {
      reconciled: false,
      reason: `${perPathTag} — moved-symbol judge proposed the same path '${oldPath}' (not a MOVED symbol); deferring`,
      evidence: `perPath: ${perPathJudgeRationale}; moved-symbol proposed '${proposedLiteral}' @ '${proposedFile}' (== oldPath) rationale: ${movedJudged.rationale}; stepA: ${stepAEvidence}`,
    };
  }

  // Safety gate: run the runner's real deterministic grep at the NEW path. A proposal that
  // doesn't actually match on the branch never lands.
  let finalGrepEvidence = "";
  try {
    const finalCheck = await deps.runDeterministicGrep({
      branchRef,
      repoRoot,
      params: { ...check.params, pattern: proposedLiteral, path: proposedFile },
    });
    finalGrepEvidence = finalCheck.evidence;
    if (finalCheck.ok) {
      return {
        reconciled: true,
        newPattern: proposedLiteral,
        newPath: proposedFile,
        step: "judge_repoint_moved_symbol",
        rationale: `judge_repoint_moved_symbol — bounded whole-diff judge mapped '${check.params.pattern}' @ '${oldPath}' → '${proposedLiteral}' @ '${proposedFile}' (${movedJudged.rationale || "no rationale"}); deterministic grep of the new (literal, path) passes on the branch`,
        evidence: `moved-symbol proposed '${proposedLiteral}' @ '${proposedFile}' rationale: ${movedJudged.rationale}; deterministic re-grep at new path: ${finalGrepEvidence}; perPath: ${perPathJudgeRationale}; stepA: ${stepAEvidence}`,
      };
    }
  } catch (e) {
    finalGrepEvidence = `runDeterministicGrep threw: ${errText(e)}`;
  }
  return {
    reconciled: false,
    reason:
      "proposal_did_not_match — moved-symbol judge proposed a (literal, file) but the deterministic grep at the new path failed; not reconciled",
    evidence: `moved-symbol proposed '${proposedLiteral}' @ '${proposedFile}' rationale: ${movedJudged.rationale}; final grep at new path: ${finalGrepEvidence || "(no evidence)"}; perPath: ${perPathJudgeRationale}; stepA: ${stepAEvidence}`,
  };
}

// ── Batch helper — the entry point the builder-worker calls from the verify path ─────────
//
// Iterates every phase's grep checks on the branch, runs the deterministic grep, and calls
// `reconcileStaleGrepCheck` on every failing `expect: 'present'` check. On a successful
// reconcile, upserts the new pattern (and, on a moved-symbol repoint, the new path too) via
// `upsertPhaseChecks` (preserves stable id — same replace-by-position semantics as the author
// path). ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2 wires
// the moved-symbol path repoint alongside the pattern repoint.)
//
// CAP — `maxReconciliationsPerBuild` bounds the number of pattern/path repoints per build so
// a pathological spec whose EVERY grep check is stale can't silently pass. Default is the
// total number of grep checks in the spec (i.e. every check may reconcile once). Exceeded →
// any remaining unreconciled checks are reported un-healed and the caller defers as before.

export interface BatchReconcileDeps extends ReconcileDeps {
  /**
   * Read the spec's phases with their grep checks. Injected so tests drive the whole policy
   * without a DB round-trip.
   */
  loadPhaseGrepChecks: (workspaceId: string, slug: string) => Promise<
    Array<{
      phaseId: string;
      phasePosition: number;
      grepChecks: Array<{ position: number; description: string; params: GrepCheckParams }>;
    }>
  >;
  /**
   * Persist the new pattern for one check row (the runner reads params from the DB on the
   * next spec-check run). Called ONLY after `reconcileStaleGrepCheck` returned reconciled=true
   * AND the deterministic grep of the new pattern passed.
   */
  upsertReconciledCheck: (args: {
    phaseId: string;
    checkPosition: number;
    description: string;
    newParams: GrepCheckParams;
  }) => Promise<void>;
  /**
   * Every reconciliation must be surfaced — never silent. Phase 1 emits a log line via this
   * hook (the console-facing audit). Phase 2 wires this same hook to the build-card audit
   * surface, so the CEO can see what was auto-corrected. Injected so tests observe.
   */
  auditReconciliation?: (audit: ReconciliationAudit) => Promise<void>;
}

export interface ReconciliationAudit {
  workspaceId: string;
  slug: string;
  phaseId: string;
  phasePosition: number;
  checkPosition: number;
  description: string;
  oldPattern: string;
  newPattern: string;
  /**
   * Present when the check's declared path moved too (step C — moved-symbol reconcile).
   * The audit row surfaces BOTH the old path (where the spec author guessed) and the new
   * path (where the whole-diff judge + deterministic grep confirmed the symbol lives).
   * Absent for step A / step B — the path was correct, only the pattern moved.
   * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
   */
  oldPath?: string;
  newPath?: string;
  /**
   * 'normalized_case' — step A (deterministic case/whitespace re-match).
   * 'judge_repoint_auto_applied' — step B: bounded judge proposal that passed the runner's
   *   real deterministic grep on the branch. See
   *   [[../../../docs/brain/libraries/check-reconciliation.md]] § step B.
   * 'judge_repoint_moved_symbol' — step C: whole-diff judge proposed a literal + a DIFFERENT
   *   file than the check's declared path; deterministic grep at the new path passed. Caller
   *   repointed BOTH `params.pattern` AND `params.path` via `upsertPhaseChecks`. See
   *   [[../../../docs/brain/libraries/check-reconciliation.md]] § step C.
   */
  step:
    | "normalized_case"
    | "judge_repoint_auto_applied"
    | "judge_repoint_moved_symbol";
  rationale: string;
  evidence: string;
}

export interface BatchReconcileArgs {
  workspaceId: string;
  slug: string;
  branchRef: string;
  repoRoot: string;
  deps: BatchReconcileDeps;
  /** Cap on repoints per build. Default: total grep-check count in the spec. */
  maxReconciliationsPerBuild?: number;
}

export interface BatchReconcileResult {
  reconciled: ReconciliationAudit[];
  unreconciled: Array<{
    phaseId: string;
    phasePosition: number;
    checkPosition: number;
    description: string;
    oldParams: GrepCheckParams;
    reason: string;
    evidence?: string;
  }>;
  capReached: boolean;
  totalGrepChecks: number;
  failingGrepChecks: number;
}

/**
 * Iterate every phase's grep checks, reconcile every failing `expect: 'present'` one, and
 * return a report the worker uses to decide "re-check accumulation" vs "defer as before".
 */
export async function reconcileFailingGrepChecksForSpec(
  args: BatchReconcileArgs,
): Promise<BatchReconcileResult> {
  const { workspaceId, slug, branchRef, repoRoot, deps } = args;
  const phases = await deps.loadPhaseGrepChecks(workspaceId, slug);
  const totalGrepChecks = phases.reduce((n, p) => n + p.grepChecks.length, 0);
  // Default cap = total grep checks (every check may be reconciled once). Never zero — a
  // spec with zero grep checks has nothing to reconcile anyway.
  const cap = Math.max(1, args.maxReconciliationsPerBuild ?? totalGrepChecks);

  const reconciled: ReconciliationAudit[] = [];
  const unreconciled: BatchReconcileResult["unreconciled"] = [];
  let failingGrepChecks = 0;
  let capReached = false;

  for (const phase of phases) {
    for (const check of phase.grepChecks) {
      // First run the real deterministic grep — if it passes, nothing to reconcile.
      const initial = await deps.runDeterministicGrep({
        branchRef,
        repoRoot,
        params: check.params,
      });
      if (initial.ok) continue;
      failingGrepChecks++;
      // expect: 'absent' misses are a real signal — never reconciled.
      if (check.params.expect !== "present") {
        unreconciled.push({
          phaseId: phase.phaseId,
          phasePosition: phase.phasePosition,
          checkPosition: check.position,
          description: check.description,
          oldParams: check.params,
          reason:
            "not_present_grep — expect='absent' misses are a real signal, never reconciled",
          evidence: initial.evidence,
        });
        continue;
      }
      if (reconciled.length >= cap) {
        capReached = true;
        unreconciled.push({
          phaseId: phase.phaseId,
          phasePosition: phase.phasePosition,
          checkPosition: check.position,
          description: check.description,
          oldParams: check.params,
          reason: `cap_reached — reconciliation cap ${cap} exhausted for this build`,
          evidence: initial.evidence,
        });
        continue;
      }
      const outcome = await reconcileStaleGrepCheck({
        check: {
          phaseId: phase.phaseId,
          phasePosition: phase.phasePosition,
          checkPosition: check.position,
          description: check.description,
          params: check.params,
        },
        branchRef,
        repoRoot,
        deps,
      });
      if (!outcome.reconciled) {
        unreconciled.push({
          phaseId: phase.phaseId,
          phasePosition: phase.phasePosition,
          checkPosition: check.position,
          description: check.description,
          oldParams: check.params,
          reason: outcome.reason,
          evidence: outcome.evidence,
        });
        continue;
      }
      // Phase 2 — on a moved-symbol outcome, upsert BOTH pattern AND path so the next verify
      // pass greps the correct file. On step A / step B, path is unchanged.
      const newParams: GrepCheckParams = {
        ...check.params,
        pattern: outcome.newPattern,
        ...(outcome.newPath ? { path: outcome.newPath } : {}),
      };
      try {
        await deps.upsertReconciledCheck({
          phaseId: phase.phaseId,
          checkPosition: check.position,
          description: check.description,
          newParams,
        });
      } catch (e) {
        // A DB write failure must NOT be masked as a reconcile — the row would still carry
        // the old pattern on the next verify pass. Report unhealed and let the caller defer.
        unreconciled.push({
          phaseId: phase.phaseId,
          phasePosition: phase.phasePosition,
          checkPosition: check.position,
          description: check.description,
          oldParams: check.params,
          reason: `upsertReconciledCheck failed: ${errText(e)}`,
          evidence: outcome.evidence,
        });
        continue;
      }
      const audit: ReconciliationAudit = {
        workspaceId,
        slug,
        phaseId: phase.phaseId,
        phasePosition: phase.phasePosition,
        checkPosition: check.position,
        description: check.description,
        oldPattern: check.params.pattern,
        newPattern: outcome.newPattern,
        // Phase 2 — surface both old + new path on a moved-symbol repoint so the CEO
        // sees the file too, not just the literal.
        ...(outcome.newPath
          ? { oldPath: check.params.path ?? ".", newPath: outcome.newPath }
          : {}),
        step: outcome.step,
        rationale: outcome.rationale,
        evidence: outcome.evidence,
      };
      reconciled.push(audit);
      if (deps.auditReconciliation) {
        try {
          await deps.auditReconciliation(audit);
        } catch (e) {
          // A best-effort audit failure never blocks a real reconciliation. The audit surface
          // is Phase 2's concern; Phase 1 still logs to console below via the worker wiring.
          console.warn(
            `[check-reconciliation] auditReconciliation threw (non-fatal): ${errText(e)}`,
          );
        }
      }
    }
  }
  return { reconciled, unreconciled, capReached, totalGrepChecks, failingGrepChecks };
}

// ── Default deps — real ripgrep / git / DB / Sonnet judge wiring ─────────────────────────
//
// The batch helper's default deps. Each is small + reads process.env / spawns / fetches
// directly, so the worker can call `reconcileFailingGrepChecksForSpec` with `defaultBatchDeps`
// as a single import. Tests pass their own deps and never touch these.

const DEFAULT_CMD_TIMEOUT_MS = 30_000;
const DEFAULT_DIFF_MAX_BYTES = 16_384;
// Whole-diff cap is higher — the moved-symbol judge (step C) must see multiple changed files
// to spot a symbol that migrated. Still bounded so a pathological branch can't blow the
// judge's context. ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
const DEFAULT_FULL_DIFF_MAX_BYTES = 48_000;

async function runCmd(
  bin: string,
  argv: string[],
  cwd: string,
  timeoutMs = DEFAULT_CMD_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, argv, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", error: (e as Error).message });
      return;
    }
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (e) => {
      clearTimeout(kill);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Case-insensitive + whitespace-tolerant normalized re-match. Uses ripgrep with the runner's
 * argv convention (`-e <pattern> -- <path>`) plus `-i` (case-insensitive) and rewrites runs of
 * whitespace in the pattern to `\s+` — the two drift classes step A is meant to catch. Returns
 * the FIRST matched line as the candidate literal so the pattern can be repointed to the
 * actually-present casing.
 */
export async function defaultNormalizedGrep(args: {
  branchRef: string;
  repoRoot: string;
  params: GrepCheckParams;
}): Promise<{ matchedLiteral: string | null; evidence: string }> {
  const path = args.params.path ?? ".";
  // Rewrite runs of whitespace in the pattern to `\s+` — tolerates a line break / extra
  // spaces inserted by a formatter. Regex-escape everything else so a plain-string pattern
  // stays plain. Belt-and-suspenders: also add the `-i` flag for case-insensitivity.
  const normalizedPattern = whitespaceTolerantPattern(args.params.pattern);
  const argv = ["-n", "-i", "-e", normalizedPattern, "--", path];
  const r = await runCmd("rg", argv, args.repoRoot);
  if (r.error) return { matchedLiteral: null, evidence: `spawn rg (normalized): ${r.error}` };
  if (r.code !== 0 && r.code !== 1) {
    return {
      matchedLiteral: null,
      evidence: (r.stderr || r.stdout || `rg exit ${r.code}`).slice(0, 2000),
    };
  }
  if (r.code === 1) return { matchedLiteral: null, evidence: "no normalized match" };
  // Ripgrep emits `<file>:<lineno>:<line>` with `-n`. Pull the first line's match text — the
  // WHOLE matched line is used verbatim as the candidate literal (the caller runs a final
  // real-grep of that literal so a spurious hit still fails closed).
  const first = r.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  const match = extractFirstOccurrenceOnLine(first, args.params.pattern);
  if (!match) {
    return {
      matchedLiteral: null,
      evidence:
        "normalized match found but could not extract candidate literal — falling through to judge",
    };
  }
  return {
    matchedLiteral: match,
    evidence: `normalized rg matched line "${first.slice(0, 200)}"`,
  };
}

/**
 * Rewrite runs of whitespace in the pattern to `\s+` so a formatter-introduced line break or
 * indentation change still matches. Regex-escapes every other character so a plain-string
 * pattern stays plain (never accidentally interpreted as a regex).
 */
export function whitespaceTolerantPattern(pattern: string): string {
  // Regex-escape then collapse runs of escaped whitespace to `\s+`.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/(\s|\\ )+/g, "\\s+");
}

/**
 * From a matched line, best-effort extract the substring that CORRESPONDS to the original
 * pattern's semantics. Simple heuristic — return the FIRST case-insensitive substring of the
 * line that matches the original pattern's non-whitespace core. This preserves the actual
 * casing present on the branch, which is what the pattern must be repointed to.
 */
export function extractFirstOccurrenceOnLine(line: string, originalPattern: string): string | null {
  const trimmedLine = line.replace(/^[^:]*:\d+:/, ""); // strip rg's `file:lineno:` prefix
  const normPattern = originalPattern.trim();
  if (!normPattern) return null;
  // Try a plain case-insensitive substring match first.
  const idx = trimmedLine.toLowerCase().indexOf(normPattern.toLowerCase());
  if (idx >= 0) return trimmedLine.slice(idx, idx + normPattern.length);
  // Fall back to the whole trimmed line (bounded) so the caller can still probe.
  return trimmedLine.trim().slice(0, 200) || null;
}

/**
 * Read the phase's branch DIFF for `path` — the input the judge reads. Bounded to
 * `DEFAULT_DIFF_MAX_BYTES` so a pathological diff can't blow the judge's context. Returns "" on
 * any git failure (the reconciler treats an empty diff as "nothing to judge" and defers).
 */
export async function defaultLoadPhaseDiff(args: {
  branchRef: string;
  repoRoot: string;
  path: string;
}): Promise<string> {
  const refTrim = args.branchRef.trim();
  if (!refTrim || refTrim.startsWith("-") || refTrim.includes("\0") || /\s/.test(refTrim)) {
    return ""; // unsafe ref — defer.
  }
  // `git diff origin/main...HEAD -- <path>` — the SYMMETRIC-difference diff (the phase's own
  // changes on top of the common merge base). `HEAD` is the branch tip; the worker has
  // already checked out the branch by the time this runs.
  const argv = ["diff", `origin/main...${refTrim}`, "--", args.path];
  const r = await runCmd("git", argv, args.repoRoot);
  if (r.error || (r.code !== 0 && r.code !== null)) {
    // git diff exits 0 on success (with or without diff content) — anything non-zero is a git
    // failure; return "" so the reconciler defers.
    return "";
  }
  return r.stdout.slice(0, DEFAULT_DIFF_MAX_BYTES);
}

/**
 * Read the ENTIRE branch diff (all changed files, not just one path) — the moved-symbol
 * judge's input in step C. Bounded to `DEFAULT_FULL_DIFF_MAX_BYTES` so a pathological diff
 * can't blow the judge's context. Returns "" on any git failure (the reconciler treats an
 * empty diff as "nothing to search for a moved symbol" and defers).
 * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
 */
export async function defaultLoadFullPhaseDiff(args: {
  branchRef: string;
  repoRoot: string;
}): Promise<string> {
  const refTrim = args.branchRef.trim();
  if (!refTrim || refTrim.startsWith("-") || refTrim.includes("\0") || /\s/.test(refTrim)) {
    return ""; // unsafe ref — defer.
  }
  // `git diff origin/main...<branchRef>` — no path arg = whole phase diff.
  const argv = ["diff", `origin/main...${refTrim}`];
  const r = await runCmd("git", argv, args.repoRoot);
  if (r.error || (r.code !== 0 && r.code !== null)) {
    return "";
  }
  return r.stdout.slice(0, DEFAULT_FULL_DIFF_MAX_BYTES);
}

/**
 * Bounded box-side intent judge — asks Claude Sonnet whether the diff satisfies the described
 * check intent under a DIFFERENT literal, and if so what the exact literal is. The judge's
 * output is JSON: `{ literal: <string|null>, rationale: <string> }`. Fails CLOSED on any
 * network / parse / API error (returns `{ literal: null }`) so a broken judge NEVER masks a
 * real code-missing failure — the caller defers unchanged.
 */
export async function defaultIntentJudge(input: {
  description: string;
  oldPattern: string;
  path: string;
  diff: string;
}): Promise<{ literal: string | null; rationale: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      literal: null,
      rationale: "ANTHROPIC_API_KEY unset — judge skipped (fail-closed)",
    };
  }
  const { SONNET_MODEL } = await import("@/lib/ai-models");
  const system =
    "You are a bounded verification judge. Your job is to decide whether a phase's branch DIFF " +
    "satisfies a check's described INTENT under a DIFFERENT literal than the check's original " +
    "pattern — i.e. the code is present but under a renamed symbol / different casing / different " +
    "wording. If YES, return the EXACT literal from the diff (a substring the caller can grep " +
    "verbatim on the branch). If NO, return null. NEVER fabricate a literal. Be conservative: " +
    "when in doubt, return null. Respond with strict JSON: " +
    '{"literal":"<string or null>","rationale":"<one sentence>"}.';
  const user = [
    `CHECK DESCRIPTION (the INTENT): ${input.description}`,
    `ORIGINAL PATTERN (what the check greps for, and MISSED on the branch): ${input.oldPattern}`,
    `PATH: ${input.path}`,
    `BRANCH DIFF for ${input.path} (bounded):`,
    "```diff",
    input.diff,
    "```",
    "",
    "Return JSON only. If the intent is genuinely satisfied under a different literal that IS present in this diff, return that literal. Otherwise return null.",
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      return { literal: null, rationale: `judge_http_${res.status}` };
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (data.content?.[0]?.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { literal: null, rationale: "judge returned no JSON" };
    const parsed = JSON.parse(m[0]) as { literal?: unknown; rationale?: unknown };
    const literal =
      typeof parsed.literal === "string" && parsed.literal.trim().length ? parsed.literal : null;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
    return { literal, rationale };
  } catch (e) {
    return { literal: null, rationale: `judge threw: ${errText(e)}` };
  }
}

/**
 * Bounded box-side moved-symbol judge — step C. Reads the WHOLE phase diff (all changed files)
 * and asks Claude Sonnet to find the check's INTENT under a DIFFERENT literal in a DIFFERENT
 * file than the spec author guessed. Returns `{literal, file, rationale}` — the literal is a
 * substring the caller can grep verbatim, the file is a path present in the diff (and NOT the
 * check's declared `oldPath`). Strict JSON, max 500 tokens. Fails CLOSED on any network /
 * parse / API error (returns `{literal: null, file: null}`) so a broken judge NEVER masks a
 * real code-missing failure — the caller defers unchanged.
 * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
 */
export async function defaultIntentJudgeMovedSymbol(input: {
  description: string;
  oldPattern: string;
  oldPath: string;
  diff: string;
}): Promise<{ literal: string | null; file: string | null; rationale: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      literal: null,
      file: null,
      rationale: "ANTHROPIC_API_KEY unset — moved-symbol judge skipped (fail-closed)",
    };
  }
  const { SONNET_MODEL } = await import("@/lib/ai-models");
  const system =
    "You are a bounded verification judge for a MOVED symbol. A spec's grep check declared a " +
    "PATH for a symbol, but the runner found no match at that path. Your job is to search the " +
    "phase's WHOLE branch diff (multiple changed files) and decide whether the check's described " +
    "INTENT is satisfied by a literal that lives in a DIFFERENT file than the declared oldPath — " +
    "i.e. the symbol moved. If YES, return the EXACT literal (a substring the caller can grep " +
    "verbatim) AND the exact file path from the diff that contains it (as it appears in the diff " +
    "header, e.g. `src/lib/foo.ts` not `a/src/lib/foo.ts`). The file MUST NOT equal the oldPath. " +
    "If NO, return {literal:null, file:null}. NEVER fabricate a literal or file. Be conservative: " +
    "when in doubt, return null. Respond with strict JSON: " +
    '{"literal":"<string or null>","file":"<string or null>","rationale":"<one sentence>"}.';
  const user = [
    `CHECK DESCRIPTION (the INTENT): ${input.description}`,
    `ORIGINAL PATTERN (what the check greps for, and MISSED on the branch): ${input.oldPattern}`,
    `ORIGINAL PATH (where the spec author expected the symbol; the code is NOT here): ${input.oldPath}`,
    `WHOLE PHASE BRANCH DIFF (bounded, multiple files):`,
    "```diff",
    input.diff,
    "```",
    "",
    "Return JSON only. If the intent is genuinely satisfied under a different literal in a DIFFERENT file (present in this diff), return that literal + that file. Otherwise return null for both.",
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      return { literal: null, file: null, rationale: `moved_symbol_judge_http_${res.status}` };
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (data.content?.[0]?.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { literal: null, file: null, rationale: "moved-symbol judge returned no JSON" };
    const parsed = JSON.parse(m[0]) as { literal?: unknown; file?: unknown; rationale?: unknown };
    const literal =
      typeof parsed.literal === "string" && parsed.literal.trim().length ? parsed.literal : null;
    const file = typeof parsed.file === "string" && parsed.file.trim().length ? parsed.file : null;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
    return { literal, file, rationale };
  } catch (e) {
    return { literal: null, file: null, rationale: `moved-symbol judge threw: ${errText(e)}` };
  }
}

/**
 * The FINAL DETERMINISTIC gate — runs the runner's real ripgrep on the branch checkout so a
 * proposal that doesn't actually match on the branch NEVER reconciles. Identical argv shape to
 * the runner's `defaultExecutors.grep` (pattern via `-e`, path after `--`). `branchRef` is not
 * used here because the worker checks the branch out into `repoRoot` before invoking this.
 */
export async function defaultRunDeterministicGrep(args: {
  branchRef: string;
  repoRoot: string;
  params: GrepCheckParams;
}): Promise<{ ok: boolean; evidence: string }> {
  const { params, repoRoot } = args;
  const argv = ["-e", params.pattern, "--", params.path ?? "."];
  const r = await runCmd("rg", argv, repoRoot);
  if (r.error) return { ok: false, evidence: `spawn rg (final): ${r.error}` };
  if (r.code !== 0 && r.code !== 1) {
    return { ok: false, evidence: (r.stderr || r.stdout || `rg exit ${r.code}`).slice(0, 2000) };
  }
  const found = r.code === 0;
  const ok = params.expect === "present" ? found : !found;
  return {
    ok,
    evidence: `deterministic rg '${params.pattern}' ${params.path ?? "."} — ${
      found ? "match(es) found" : "no match"
    } (expect=${params.expect})`,
  };
}

/**
 * Load every phase's grep checks for a spec. Reads via the SDK — `getSpec` for the phase list
 * (position + id) then `listPhaseChecks` per phase filtered to `exec_kind='grep'`. Skips phases
 * with no grep checks (nothing to reconcile).
 */
export async function defaultLoadPhaseGrepChecks(
  workspaceId: string,
  slug: string,
): Promise<
  Array<{
    phaseId: string;
    phasePosition: number;
    grepChecks: Array<{ position: number; description: string; params: GrepCheckParams }>;
  }>
> {
  const { getSpec } = await import("@/lib/specs-table");
  const { listPhaseChecks } = await import("@/lib/spec-phase-checks-table");
  const spec = await getSpec(workspaceId, slug);
  if (!spec) return [];
  const out: Array<{
    phaseId: string;
    phasePosition: number;
    grepChecks: Array<{ position: number; description: string; params: GrepCheckParams }>;
  }> = [];
  for (const phase of [...(spec.phases ?? [])].sort((a, b) => a.position - b.position)) {
    const rows = await listPhaseChecks(phase.id);
    const greps: Array<{ position: number; description: string; params: GrepCheckParams }> = [];
    for (const r of rows) {
      if (r.exec_kind !== "grep") continue;
      const p = r.params as GrepCheckParams | null;
      if (!p || typeof p.pattern !== "string") continue;
      if (p.expect !== "present" && p.expect !== "absent") continue;
      greps.push({ position: r.position, description: r.description, params: p });
    }
    if (greps.length) {
      out.push({ phaseId: phase.id, phasePosition: phase.position, grepChecks: greps });
    }
  }
  return out;
}

/**
 * Repoint one check row's params to the reconciled shape — `pattern` always, and (on a
 * moved-symbol step-C repoint) `path` too. Uses the SDK `upsertPhaseChecks` (replace-by-
 * position preserves stable ids) — we upsert JUST the one position with new params, matching
 * the SDK's semantics. The other positions on the phase are re-read + carried through so a
 * single-check repoint doesn't clear the others.
 * ([[build-verify-reconciler-auto-applies-renames-and-moved-symbols]] Phase 2.)
 */
export async function defaultUpsertReconciledCheck(args: {
  phaseId: string;
  checkPosition: number;
  description: string;
  newParams: GrepCheckParams;
}): Promise<void> {
  const { listPhaseChecks, upsertPhaseChecks } = await import("@/lib/spec-phase-checks-table");
  const rows = await listPhaseChecks(args.phaseId);
  // Rebuild the full list (replace-by-position preserves ids on non-touched positions).
  const inputs = rows.map((r) => ({
    position: r.position,
    description: r.description,
    kind: r.kind,
    exec_kind: r.exec_kind,
    params: r.position === args.checkPosition ? args.newParams : r.params,
  }));
  await upsertPhaseChecks(args.phaseId, inputs);
}

/**
 * Persist each reconciliation to the CEO-visible build-card audit surface — the shared
 * `director_activity` feed EVERY autonomous build supervisor reads (Ada + the EOD recap +
 * the #directors board). Called by `reconcileFailingGrepChecksForSpec` on every successful
 * repair; the writer is best-effort + never throws (a director-activity blip must never mask
 * a real reconciliation).
 *
 * The row's `action_kind='check_reconciled'` carries the full audit shape a reader needs to
 * eyeball the auto-correction: old_pattern → new_pattern, the check description (intent),
 * the STEP that fired (`normalized_case` — the deterministic step A, or
 * `judge_repoint_auto_applied` — a bounded judge proposal that survived the runner's real
 * deterministic grep on the branch, or `judge_repoint_moved_symbol` — the whole-diff judge
 * repointed BOTH pattern AND path because the symbol moved to a different file), the
 * rationale, and the evidence string the deterministic gate produced. On a moved-symbol
 * repoint the row also carries `old_path` + `new_path`. This is the "never silent" hard
 * rule the audit-surface spec cites — a self-healing check that isn't surfaced is a proxy
 * that optimizes itself.
 */
export async function defaultAuditReconciliation(audit: ReconciliationAudit): Promise<void> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { recordDirectorActivity } = await import("@/lib/director-activity");
    const admin = createAdminClient();
    // Phase 2 — surface the path move on the human-facing reason line too (not just metadata).
    const pathMove = audit.newPath && audit.oldPath && audit.newPath !== audit.oldPath
      ? ` @ path '${audit.oldPath}' → '${audit.newPath}' (moved_symbol)`
      : "";
    await recordDirectorActivity(admin, {
      workspaceId: audit.workspaceId,
      directorFunction: "platform",
      actionKind: "check_reconciled",
      specSlug: audit.slug,
      reason: `phase ${audit.phasePosition} check '${audit.description.slice(0, 200)}' auto-corrected via ${audit.step}: '${audit.oldPattern}' → '${audit.newPattern}'${pathMove} — ${audit.rationale.slice(0, 400)}`.slice(0, 4000),
      metadata: {
        spec_slug: audit.slug,
        phase_id: audit.phaseId,
        phase_position: audit.phasePosition,
        check_position: audit.checkPosition,
        check_description: audit.description,
        old_pattern: audit.oldPattern,
        new_pattern: audit.newPattern,
        // Phase 2 — moved-symbol path move (only set for step='judge_repoint_moved_symbol').
        ...(audit.oldPath ? { old_path: audit.oldPath } : {}),
        ...(audit.newPath ? { new_path: audit.newPath } : {}),
        step: audit.step,
        rationale: audit.rationale,
        evidence: audit.evidence,
        autonomous: true,
      },
    });
  } catch (e) {
    // Best-effort — never throw. A director-activity blip is worse than the gap it records.
    console.warn(
      `[check-reconciliation] defaultAuditReconciliation threw (non-fatal): ${errText(e)}`,
    );
  }
}

/**
 * Cap-reached / defer-with-un-reconcilable-list surface — the DEFERRING side of the audit
 * (the reconciled side is `defaultAuditReconciliation` above). One row PER build whose
 * `reconcileFailingGrepChecksForSpec` returned an unreconciled list, so the CEO sees WHICH
 * checks the reconciler could not heal + the reasons (`no_normalized_match`, `judge_declined`,
 * `cap_reached`, …) — the real-failure path is preserved, never silently masked. Emit-once
 * from the worker after the batch reconciler returns.
 */
export async function recordCapReachedOrUnhealedDefer(input: {
  workspaceId: string;
  slug: string;
  jobId: string | null;
  cap: number;
  reconciledCount: number;
  unreconciled: BatchReconcileResult["unreconciled"];
  capReached: boolean;
}): Promise<void> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { recordDirectorActivity } = await import("@/lib/director-activity");
    const admin = createAdminClient();
    const preview = input.unreconciled
      .slice(0, 5)
      .map((u) => `p${u.phasePosition}.c${u.checkPosition} '${u.description.slice(0, 60)}' → ${u.reason}`)
      .join(" | ");
    await recordDirectorActivity(admin, {
      workspaceId: input.workspaceId,
      directorFunction: "platform",
      actionKind: "check_reconcile_cap_reached",
      specSlug: input.slug,
      reason:
        `phase-verify reconciler: ${input.reconciledCount} check(s) auto-corrected, ` +
        `${input.unreconciled.length} un-reconcilable ` +
        `(cap=${input.cap}, cap_reached=${input.capReached}) — deferring build with real-failure list preserved. ` +
        `First: ${preview.slice(0, 800)}`.slice(0, 4000),
      metadata: {
        job_id: input.jobId,
        spec_slug: input.slug,
        cap: input.cap,
        reconciled_count: input.reconciledCount,
        cap_reached: input.capReached,
        unreconciled: input.unreconciled.map((u) => ({
          phase_id: u.phaseId,
          phase_position: u.phasePosition,
          check_position: u.checkPosition,
          description: u.description,
          old_pattern: u.oldParams.pattern,
          reason: u.reason,
          evidence: u.evidence ?? null,
        })),
        autonomous: true,
      },
    });
  } catch (e) {
    console.warn(
      `[check-reconciliation] recordCapReachedOrUnhealedDefer threw (non-fatal): ${errText(e)}`,
    );
  }
}

/** The default batch deps — a single import for the worker's verify path. */
export const defaultBatchDeps: BatchReconcileDeps = {
  normalizedGrep: defaultNormalizedGrep,
  loadPhaseDiff: defaultLoadPhaseDiff,
  intentJudge: defaultIntentJudge,
  runDeterministicGrep: defaultRunDeterministicGrep,
  loadFullPhaseDiff: defaultLoadFullPhaseDiff,
  intentJudgeMovedSymbol: defaultIntentJudgeMovedSymbol,
  loadPhaseGrepChecks: defaultLoadPhaseGrepChecks,
  upsertReconciledCheck: defaultUpsertReconciledCheck,
  auditReconciliation: defaultAuditReconciliation,
};
