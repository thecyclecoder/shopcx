/**
 * autobuild-circuit-break-on-repeated-pre-commit-self-verify-failure Phase 2 — the PURE decision behind
 * the build lane's "escaped to fix-phase self-heal" branch (scripts/builder-worker.ts `runBuildJob`).
 *
 * Ground truth: close-snapshot-coverage-guard looped >1 month. Every failed build logged "escaped to
 * fix-phase self-heal", yet `spec_phases` still held only the original planned phases — the escape branch
 * materialized NOTHING (it just set the job `failed`), so the next build restarted from scratch and failed
 * identically. The reason: the one failing check was `the registered test suite passes (unit_test)` — a
 * WHOLE-ARTIFACT check (it runs the entire registered suite, not a per-file positive-absence probe), which
 * cannot be decomposed into a concrete per-anchor fix phase. "Make the whole suite pass" is just the same
 * build again. So the self-heal was a silent no-op.
 *
 * This module makes that branch do ONE of two things, explicitly:
 *   - APPEND concrete fix phases — one per per-anchor (`grep`) failing check, each with a locally-checkable
 *     verification naming the exact missing anchor, so the NEXT build addresses them specifically; or
 *   - record a structured `self_heal_noop` reason — when every failing check is whole-artifact (so no
 *     per-file fix phase can decompose it), a pending fix phase already covers the anchors, or the fix-cycle
 *     loop-guard is hit — so the Phase-1 re-enqueue circuit breaker ([[agent-jobs]] `enqueueBuildIfDue`
 *     `selfVerifyCircuitDecision`) is the explicit stop instead of an endless clean rebuild.
 *
 * Kept PURE (no IO) so the decompose-vs-noop decision is unit-tested directly; the builder-worker branch
 * is the thin wiring that reads `spec_phases`, calls `appendFixPhases`, and records the director_activity
 * outcome row.
 */

/** A worktree-reflecting self-verify failing check, as produced by `preCommitSelfVerify`. */
export interface SelfVerifyFailure {
  text: string;
  exec_kind: string | null;
  evidence?: string;
}

/** A `spec_phases` row (the subset this decision needs) for the fix-phase dedup + loop-guard. */
export interface ExistingFixPhaseRow {
  status: string;
  build_sha: string | null;
  origin_check_keys: string[] | null;
}

/** The `appendFixPhases` input shape ([[specs-table]]). */
export interface SelfVerifyFixPhaseInput {
  title: string;
  body: string;
  verification: string;
  origin_check_keys: string[];
}

/**
 * Whole-artifact self-verify kinds — each runs an ENTIRE suite / build / typecheck, not a per-anchor
 * positive-absence probe. A failing one cannot be decomposed into a concrete per-file fix phase ("make
 * the whole suite pass" == the same build again), so it routes to `self_heal_noop` and the re-enqueue
 * breaker. The self-verify set is {grep, tsc, unit_test, build}; of those only `grep` is per-anchor.
 */
export const WHOLE_ARTIFACT_SELF_VERIFY_KINDS: ReadonlySet<string> = new Set(["unit_test", "build", "tsc"]);

/** Bound the fix-cycle count on a spec. At the cap a still-red re-verify means the fixes aren't converging
 *  → stop appending and let the breaker fire. Env-overridable; mirrors `PRE_MERGE_FIX_LOOP_GUARD_MAX`. */
export const SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX = Number(
  process.env.SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX || 3,
);

/**
 * Is this failing self-verify check decomposable into a concrete per-anchor fix phase? True for a per-anchor
 * positive-absence probe (`grep` — "export X exists in Y"): the body can name the exact missing anchor.
 * False for a whole-artifact kind (unit_test / build / tsc) and for an unknown/null kind we can't safely
 * decompose.
 */
export function isDecomposableSelfVerifyCheck(execKind: string | null | undefined): boolean {
  if (!execKind) return false;
  return !WHOLE_ARTIFACT_SELF_VERIFY_KINDS.has(execKind);
}

/** Stable per-check key — `<kind>:<normalized text>`. Used for the pending-fix-phase dedup signature so a
 *  re-run that would append the SAME anchors no-ops instead of stacking a duplicate fix phase. */
export function selfVerifyCheckKey(f: SelfVerifyFailure): string {
  const kind = (f.exec_kind || "unknown").trim().toLowerCase();
  const text = (f.text || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
  return `${kind}:${text}`;
}

export type SelfHealNoopReason = "no_failing" | "all_whole_artifact" | "already_pending" | "loop_guard";

export type SelfHealDecision =
  | { action: "append"; fixes: SelfVerifyFixPhaseInput[]; signature: string; decomposableKeys: string[] }
  | { action: "noop"; reason: SelfHealNoopReason; detail: string };

/**
 * The decompose-or-report decision for the cap-exhausted self-verify failure. APPEND one fix phase per
 * per-anchor (`grep`) failing check when there is new, specific, locally-checkable work to hand the next
 * build; otherwise NOOP with a structured reason (whole-artifact-only, already-pending, or loop-guard) so
 * the Phase-1 circuit breaker is the stop rather than a silent clean-rebuild loop.
 */
export function decideSelfVerifySelfHeal(input: {
  failing: SelfVerifyFailure[];
  existingFixPhases: ExistingFixPhaseRow[];
  loopGuardMax?: number;
}): SelfHealDecision {
  const loopGuardMax = input.loopGuardMax ?? SELF_VERIFY_FIX_PHASE_LOOP_GUARD_MAX;
  const failing = input.failing || [];
  if (failing.length === 0) {
    return { action: "noop", reason: "no_failing", detail: "no failing self-verify checks to self-heal" };
  }

  const decomposable = failing.filter((f) => isDecomposableSelfVerifyCheck(f.exec_kind));
  if (decomposable.length === 0) {
    const kinds = [...new Set(failing.map((f) => f.exec_kind || "unknown"))].join(", ");
    return {
      action: "noop",
      reason: "all_whole_artifact",
      detail:
        `all ${failing.length} failing self-verify check(s) are whole-artifact (${kinds}) — each runs an entire ` +
        `suite/build/typecheck, not a per-anchor positive-absence probe, so no per-file fix phase can decompose ` +
        `them; a clean rebuild re-fails identically. The re-enqueue circuit breaker is the stop.`,
    };
  }

  const decomposableKeys = decomposable.map(selfVerifyCheckKey);
  const keySig = [...new Set(decomposableKeys)].sort().join(",");

  // Dedup — a still-unbuilt fix phase already covers EXACTLY these anchors; the next build addresses it.
  const pending = input.existingFixPhases.find(
    (p) =>
      p.status !== "shipped" &&
      p.status !== "rejected" &&
      !p.build_sha &&
      [...new Set(p.origin_check_keys || [])].sort().join(",") === keySig,
  );
  if (pending) {
    return {
      action: "noop",
      reason: "already_pending",
      detail: `a pending (unbuilt) fix phase already covers these ${decomposableKeys.length} anchor(s): ${keySig}`,
    };
  }

  // Loop-guard — bound the fix cycles; at the cap the fixes aren't converging, hand off to the breaker.
  if (input.existingFixPhases.length >= loopGuardMax) {
    return {
      action: "noop",
      reason: "loop_guard",
      detail:
        `${input.existingFixPhases.length} fix phase(s) already appended on this spec and the self-verify is STILL ` +
        `red — loop-guard cap (${loopGuardMax}) reached; another fix phase won't converge. The circuit breaker is the stop.`,
    };
  }

  const fixes: SelfVerifyFixPhaseInput[] = decomposable.map((f) => {
    const key = selfVerifyCheckKey(f);
    const label = (f.text || "").trim().replace(/\s+/g, " ").slice(0, 120);
    return {
      title: `Fix — materialize self-verify anchor: ${label}`,
      body: [
        `The pre-commit self-verify check \`${f.text}\` (${f.exec_kind}) FAILED against the build worktree after the in-session repair cap was exhausted.`,
        `This is a positive-absence gap: the spec's Verification bullet asserts this anchor exists, but the build never created it.`,
        `Make the file/export/column this check probes for exist in the worktree. Do NOT weaken, delete, or re-point the Verification bullet to make it pass.`,
        f.evidence ? `Evidence from the last run: ${f.evidence.slice(0, 600)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      verification: `- \`${f.text}\` (${f.exec_kind}) passes against the worktree.`,
      origin_check_keys: [key],
    };
  });

  return { action: "append", fixes, signature: keySig, decomposableKeys };
}
