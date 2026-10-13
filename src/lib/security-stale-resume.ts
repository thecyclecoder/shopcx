/**
 * Phase 5 of [[../../.box/spec-inflection-resession-must-act-on-newest-ask.md]] (Fix 1 — resolve 1
 * pre-merge spec-test regression) — detect a "stale resume" security-review verdict.
 *
 * Background. `resolveReviewVerdict` (scripts/builder-worker.ts) runs attempt 2 as a cheap same-session
 * parse-repair re-prompt: the model is asked to re-emit the final JSON verdict envelope, reusing the
 * findings it already produced on attempt 1 (`securityReviewRepairPrompt`). The repair prompt is explicit
 * — "do NOT re-investigate … reuse the findings + reasoning you ALREADY produced".
 *
 * The failure mode. When attempt 1 produced a session id but its session no longer holds any real review
 * (an aborted first run, a usage-wall mid-pass, a reaped resume), the resumed repair session has nothing
 * to re-emit from. The model dutifully says it has no prior findings and surfaces a stock `needs-human`
 * verdict asking a human to re-trigger the review from scratch. That verdict is syntactically a valid
 * `needs-human`, so `resolveReviewVerdict` accepts it as authoritative — the build parks with a
 * `real_blocker`-class needs_attention, blocking the merge even though the on-branch code has no
 * security issue. The dc31bf31 build of `inflection-resession-must-act-on-newest-ask` hit this on the
 * parked security-review job 8040a2d9.
 *
 * The fix. When a REPAIR-attempt parsed verdict is `needs-human` and the review text matches a known
 * stale-resume signature, discard it — fall through to `fallbackReason` instead. The fallback carries
 * the "produced no parseable verdict" phrase that
 * [[./agents/platform-director.ts]] `TRIAGE_RECOVERABLE_ERROR` recognizes as inconclusive, so
 * `reconcileNeedsAttention` re-runs the review ONCE as a fresh session (no resume). A fresh session
 * reviews the branch from scratch — no stale-session confusion — and emits a real verdict.
 *
 * This module is a pure helper so the detector can be unit-tested without the worker lane.
 */

/**
 * The stale-resume signature. Matches the stock phrasings a resumed security-review session emits when
 * its own prior findings are not in context:
 *   - "No prior findings available in this session context"
 *   - "the previous security-review run did not carry over"
 *   - "a human should re-trigger the review from scratch"
 *   - "re-run the review from scratch"
 * Any one phrase is enough — the ground-truth tail (parked job 8040a2d9) contained all three joined by
 * em-dashes.
 */
const STALE_RESUME_SIGNATURES = [
  /no\s+prior\s+findings\s+available/i,
  /did\s+not\s+carry\s+over/i,
  /re-?trigger\s+the\s+review\s+from\s+scratch/i,
  /re-?run\s+the\s+review\s+from\s+scratch/i,
];

/**
 * Returns true iff `review` carries the stale-resume signature — i.e. the model is saying its resumed
 * session cannot continue because it has no prior findings in context. Pure; defensive against null /
 * non-string.
 */
export function looksLikeStaleResumeAcknowledgement(review: unknown): boolean {
  if (typeof review !== "string") return false;
  if (!review.trim()) return false;
  return STALE_RESUME_SIGNATURES.some((rx) => rx.test(review));
}

/**
 * Decide whether a parsed verdict should be DISCARDED (treated as inconclusive) given which attempt
 * emitted it. The guard only fires on a REPAIR attempt (useRepair=true): a FRESH attempt is a genuine
 * review and its `needs-human` is a real human-needed verdict.
 *
 * ⭐ security-review-lane-must-always-produce-a-verdict Phase 2 — STRUCTURAL rule (broadened from the
 * original phrase match). A repair attempt is a parse-REPAIR of a review that already ran; the repair
 * prompt no longer offers `needs-human` as a shape at all, so ANY `needs-human` emitted on a repair
 * attempt means the resumed session had nothing to re-emit (the stale-resume failure) — NOT that a human
 * is genuinely needed. Discard every repair-attempt `needs-human` so the caller falls back to the
 * actionable "no parseable verdict" reason and the triage re-runs the review FRESH (the only recovery
 * that actually re-reviews the code). The old phrase match (`looksLikeStaleResumeAcknowledgement`) is
 * retained as an exported helper for diagnostics but is no longer the gate — a stale resume doesn't
 * always emit a recognizable phrase, and the structural fact (repair-attempt needs-human) is sufficient.
 *
 * The `recognized` set is passed through so the helper stays decoupled from the specific verdict
 * vocabulary each lane uses.
 */
export function shouldDiscardStaleResumeVerdict(input: {
  useRepair: boolean;
  verdict: string;
  review: unknown;
  recognized: ReadonlySet<string>;
}): boolean {
  if (!input.useRepair) return false;
  if (input.verdict !== "needs-human") return false;
  if (!input.recognized.has("needs-human")) return false;
  // Structural rule: a repair-attempt needs-human is never trustworthy (see above) — discard it
  // regardless of whether the review text carries a recognizable stale-resume phrase.
  return true;
}
