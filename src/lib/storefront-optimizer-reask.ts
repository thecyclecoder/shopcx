// Pure re-ask decision helper for the storefront-optimizer lane
// (docs/brain/specs/storefront-optimizer-re-asks-once-before-parking.md Phase 1).
//
// The storefront-optimizer box session sometimes finishes eleven turns of real reasoning and lands
// on a sound lever, then answers in markdown prose instead of the JSON envelope the worker parses.
// Before this helper, `parsed` was null and the lane dropped straight into
// `update(job, needs_attention, "storefront-optimizer ended without a recognizable status")` — the
// completed work discarded on a formatting slip nobody could action from the park.
//
// Mirrors the same-session parse-repair the deploy-review and mario lanes already use: ONE bounded
// re-ask on the SAME box session for ONLY the JSON envelope, no re-analysis, then park if that
// second attempt is still unparseable. Kept as a pure function so the decision is testable without
// importing scripts/builder-worker.ts (which boots the worker on import).

export interface ReAskDecisionInput {
  /** The result of `extractJson<Record<string, unknown>>(resultText)` on this attempt. */
  parsed: Record<string, unknown> | null;
  /** The box session's `isError` stream flag on this attempt. */
  isError: boolean;
  /** Has the lane already spent its ONE re-ask on this job? Tracked in-scope, no DB column. */
  alreadyReAsked: boolean;
}

export type ReAskDecision = "re_ask" | "park" | "fail" | "continue";

/**
 * The single decision the storefront-optimizer lane consults on its terminal fall-through:
 *
 * - `parsed?.status` is a recognized branch → `"continue"` (never re-ask; existing branches handle it)
 * - `isError && !parsed`                    → `"fail"`    (the pre-existing failure branch, untouched)
 * - `!parsed && !alreadyReAsked`            → `"re_ask"`  (the one bounded re-ask this phase adds)
 * - `!parsed && alreadyReAsked`             → `"park"`    (the pre-existing park, now labeled)
 *
 * A `parsed` object with a recognized status (`idle` / `needs_input` / `needs_build` / `propose`)
 * MUST never re-ask — the existing branches already handle those cases before this helper runs.
 * The `continue` return is the safety net if the caller wires the helper before the status branches.
 */
export function shouldReAskForJsonEnvelope(input: ReAskDecisionInput): ReAskDecision {
  const { parsed, isError, alreadyReAsked } = input;

  if (parsed && typeof parsed.status === "string") {
    const status = parsed.status;
    if (status === "idle" || status === "needs_input" || status === "needs_build" || status === "propose") {
      return "continue";
    }
  }

  if (isError && !parsed) return "fail";

  if (!parsed && !alreadyReAsked) return "re_ask";

  return "park";
}

/**
 * The literal instruction handed to the SAME box session on the re-ask. Purposely short — the
 * session already did the analysis in its eleven turns; asking for a fresh diagnosis would double
 * the token spend AND could change the answer. The model has its findings in memory; it just needs
 * to re-emit them in the recognized shape.
 */
export function storefrontOptimizerReAskPrompt(): string {
  return [
    `Your previous message could not be parsed as the storefront-optimizer JSON envelope.`,
    `Return ONLY one valid JSON object — no prose before or after, no markdown, no commentary. If you must use a code fence the JSON must be the last thing in the message. Reuse the analysis you ALREADY produced; do NOT re-read files, do NOT re-run any tool, do NOT change the answer.`,
    ``,
    `The envelope's "status" field must be one of: "idle" | "needs_input" | "needs_build" | "propose".`,
    `Re-emit the SAME decision you already reached, in that exact shape.`,
  ].join("\n");
}
