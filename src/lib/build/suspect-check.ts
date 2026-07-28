/**
 * a-verification-check-must-not-demand-a-name-the-builder-has-to-guess Phase 2 — the pure suspect-check
 * detector. Phase 1 stops NEW bad checks at author time; this stops OLD bad checks from being escalated
 * to the founder as "build unbuildable" when the real defect is a phase-check that pins a builder-chosen
 * literal (`test:graduate-crowned` while the branch registered `test:media-buyer-graduate-scaler`).
 *
 * The signal: the SAME single check has been the ONLY failing check across N recent builds while its
 * siblings passed. A phase failing on many checks (or a different check each build) is more likely a
 * real code miss than a bad check — the detector never fires on those. When it DOES fire, the caller
 * ([[../roadmap-actions.ts]] `redriveDeferredBuildOrEscalate` on escalate) rewrites the escalation
 * summary from 'phase-accumulation checks failed' to 'check X of phase Y has failed N builds while
 * every other check passed — the check is the likely defect' and offers a loosen-the-check remedy
 * alongside the existing reclaim_stuck_build approval. Same authoring-defect vs build-defect split as
 * Phase 1.
 *
 * Pure — no DB, no I/O. Callers gather the history (prior `director_activity` metadata rows in the
 * live path; hand-built fixtures in the tests) and hand a `SuspectCheckInput` to `detectSuspectCheck`.
 */

/** One prior build's failing-check summary, sourced from that build's `director_activity` metadata. */
export interface PriorRunFailure {
  /** ISO timestamp of the redrive/escalate `director_activity` row. Used only to order runs newest → oldest. */
  at: string;
  /** Per-check keys (via [[../spec-test-runs]] `checkKey`) that were failing in that run's reconcile output. */
  failingKeys: string[];
}

export interface SuspectCheckInput {
  /** Prior builds' failing-check summaries — any order; the detector sorts newest → oldest. */
  priorRuns: PriorRunFailure[];
  /** Failing-check keys observed on THIS build (the one about to escalate). */
  currentFailingKeys: string[];
  /**
   * Total consecutive-lone-failure builds (including the current one) required to call a check
   * suspect. Default 3 — matches the shape observed on `bianca-actually-graduates-...` and
   * `factor-scores-reweight-selection-engine` (5 and 4 identical builds respectively, both well
   * past a threshold of 3).
   */
  threshold?: number;
}

export interface SuspectCheckResult {
  /** The check_key that has failed as the lone failing check across ≥ threshold builds. */
  checkKey: string;
  /** Number of consecutive builds (including the current one) that failed only on this key. */
  count: number;
  /** Threshold actually used. Echoed so the caller can render "N of THRESHOLD" cleanly. */
  threshold: number;
}

export const DEFAULT_SUSPECT_CHECK_THRESHOLD = 3;

/**
 * Returns a suspect check_key when the SAME single check has been the ONLY failing check across a
 * streak of `threshold` consecutive builds (including the current one). `null` in every other case —
 * multi-check failures, streak-breakers, and short histories all read as "real build problem, not a
 * suspect check." Fail-CLOSED on ambiguity: a null result means the escalation stays as-is; the
 * detector never falsely relabels a genuine build defect as a bad check.
 */
export function detectSuspectCheck(input: SuspectCheckInput): SuspectCheckResult | null {
  const threshold = input.threshold ?? DEFAULT_SUSPECT_CHECK_THRESHOLD;
  if (threshold < 2) return null;
  // The current run must have exactly one failing check — the "lone failing check" invariant.
  // A build failing on multiple checks is nearly always a real code miss, and mislabeling those
  // as "check is the likely defect" would send the CEO the wrong ask.
  if (input.currentFailingKeys.length !== 1) return null;
  const suspectKey = input.currentFailingKeys[0];
  if (!suspectKey) return null;

  // Walk prior runs newest → oldest. Each run must ALSO have exactly one failing key equal to the
  // suspect key; any break (empty, multiple, or different key) ends the streak.
  const sorted = [...input.priorRuns].sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
  let count = 1;
  for (const p of sorted) {
    if (p.failingKeys.length !== 1) break;
    if (p.failingKeys[0] !== suspectKey) break;
    count++;
    if (count >= threshold) break;
  }
  if (count < threshold) return null;
  return { checkKey: suspectKey, count, threshold };
}

/**
 * Format the human-readable escalation summary when the detector fires. The exact text the spec
 * ("Phase 2 § 2") calls for — surfaces the count, the phase, the check, and the near-miss evidence
 * so the CEO sees a check-authoring defect instead of a build defect.
 *
 * Pure — the caller supplies pre-computed check text + phase position + near-miss evidence.
 */
export function formatSuspectCheckSummary(input: {
  slug: string;
  suspect: SuspectCheckResult;
  checkDescription: string;
  phasePosition: number;
  checkPosition: number;
  /** For a `grep`, the failing pattern the check pins. Used to render the near-miss remedy. */
  failingPattern?: string;
  /** For a `grep`, the corrected pattern the Phase-1 detector or reconciler surfaced. */
  suggestedPattern?: string;
  /** For a `grep`, a short substring found on the branch that the failing pattern narrowly missed. */
  nearMissEvidence?: string;
}): string {
  const { slug, suspect, checkDescription, phasePosition, checkPosition } = input;
  const head =
    `Spec ${slug} — check ${checkPosition} of phase ${phasePosition} has failed ` +
    `${suspect.count} builds while every other check passed — the check is the likely defect ` +
    `(not an unbuilt phase). Check: "${checkDescription.slice(0, 160)}".`;
  const parts: string[] = [head];
  if (input.nearMissEvidence) {
    parts.push(`Branch DOES contain a near-miss: ${input.nearMissEvidence.slice(0, 240)}`);
  }
  if (input.failingPattern && input.suggestedPattern) {
    parts.push(
      `Remedy — loosen the check: replace grep.pattern "${input.failingPattern}" ` +
        `with "${input.suggestedPattern}" (or accept the branch's actual string).`,
    );
  } else if (input.suggestedPattern) {
    parts.push(`Remedy — loosen the check to: ${input.suggestedPattern}`);
  }
  return parts.join(" ");
}
