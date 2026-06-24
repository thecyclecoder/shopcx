/**
 * director-bounce-back — the CEO 'you handle this' affordance for a stranded director escalation
 * (bounce-escalation-back-to-director spec).
 *
 * When a director escalates a sound diagnosis the CEO inbox can render only Dismiss for. This module
 * is the small shared layer behind the bounce: the lane derivation (which judgment lane produced the
 * escalation), the preamble the director reads on its next invocation, and the typed instructions
 * the new `kind='director-bounce-back'` agent_jobs row carries. The endpoint, the UI, and the worker
 * handler all share these types so the bounce stays one-shape across the stack.
 *
 * Depth cap (one round-trip, by design): the FIRST bounce enqueues a job with depth=1. The worker's
 * re-investigation either lands an action OR re-escalates exactly once — the re-escalation card
 * carries `metadata.bounced_back_depth=2`, the UI hides Send-back, and the endpoint refuses
 * `depth >= 1`. See the spec's Safety / invariants.
 */

import { CEO } from "@/lib/agents/approval-router";

/** Which judgment lane produced the escalation — drives the prompt + the dispatch on re-investigation. */
export type BounceBackLane = "groom" | "init" | "repair-dismissal" | "approval";

/**
 * Derive the originating lane from a CEO-routed escalation notification's metadata. Maps the
 * `escalation_kind` the lib emitters set (groom_unsure / init-unsure / repair_dismissal_suspect …) to
 * its lane. Falls back to `approval` for an Approval-Request escalation (escalateApprovalRequestToCeo
 * doesn't set escalation_kind; it just flips routed_to_function + escalated_by_director on the existing
 * request). Returns null when the notification ISN'T a director escalation we can bounce.
 */
export function laneForBounceBack(meta: Record<string, unknown>): BounceBackLane | null {
  // Must have been escalated BY a director to be eligible — the bounce is "send it back to {Director}".
  const escalatedBy = typeof meta["escalated_by_director"] === "string" ? (meta["escalated_by_director"] as string) : "";
  if (!escalatedBy) return null;
  // Must currently be routed to the CEO (the bounce is from the CEO inbox).
  const routedTo = typeof meta["routed_to_function"] === "string" ? (meta["routed_to_function"] as string) : "";
  if (routedTo !== CEO) return null;

  const kind = typeof meta["escalation_kind"] === "string" ? (meta["escalation_kind"] as string) : "";
  if (kind.startsWith("groom_") || kind.startsWith("groom-")) return "groom";
  if (kind === "init-unsure" || kind === "initguard" || kind.startsWith("init_")) return "init";
  if (kind === "repair_dismissal_suspect" || kind === "external_blocker" || kind.startsWith("repair_")) return "repair-dismissal";
  // No escalation_kind set ⇒ the approval-request escalation path (escalateApprovalRequestToCeo).
  // Those always carry agent_job_id (the target build's id).
  if (typeof meta["agent_job_id"] === "string") return "approval";
  return null;
}

/** The carried context the bounce-back endpoint stamps into the new agent_jobs row's instructions. */
export interface BounceBackInstructions {
  lane: BounceBackLane;
  /** the director the bounce is sent back to (currently always 'platform'). */
  director_slug: string;
  /** the spec slug the original escalation targeted (groom/init lanes; approval when present). */
  candidate_slug: string | null;
  /** the agent_job id the original escalation routed (approval/repair-dismissal lanes). */
  candidate_job_id: string | null;
  /** the error_events signature the repair-dismissal lane keyed on. */
  candidate_signature: string | null;
  /** the dismissed CEO notification id (audit + back-reference). */
  notification_id: string;
  /** the CEO's optional one-line note shown verbatim to the director. */
  ceo_note: string | null;
  /** the diagnosis the original escalation carried — shown to the director as "what you said last time". */
  original_escalation_reason: string;
  /** the original escalation's `escalation_kind` + `dedupe_key` — the re-escalate path reuses them. */
  original_escalation_kind: string | null;
  original_dedupe_key: string | null;
  /** the round-trip counter. First bounce = 1; cap = 1 (a re-escalate writes a card with bounced_back_depth=2). */
  depth: number;
}

/** The preamble a bounce-back investigation prepends to its lane's prompt — same shape every lane. */
export function bounceBackPreamble(ctx: BounceBackInstructions): string {
  const note = (ctx.ceo_note ?? "").trim();
  const lines = [
    "The CEO sent this back to you. Use the richer judgment-lanes verdicts to land a real action.",
    "",
    "You previously escalated this with the diagnosis below. The CEO chose to let you handle it instead of",
    "deciding manually — the richer verdict set (fold_now / author_followup_spec / dismiss_candidate, plus",
    "the lane's native ones) is available now. Land the right action this time — re-escalate ONLY if you",
    "genuinely cannot.",
    "",
    "Your prior diagnosis:",
    "----------------------------------------",
    (ctx.original_escalation_reason || "(no prior diagnosis recorded)").slice(0, 3000),
    "----------------------------------------",
  ];
  if (note) {
    lines.push("", `CEO note: ${note.slice(0, 500)}`);
  }
  lines.push("", "(Bounce depth: this is round-trip #" + ctx.depth + " — the cap is one; re-escalating sends both diagnoses to the CEO with no further bounce.)", "");
  return lines.join("\n");
}

/** Convenience: stable kind string for the bounce-back agent_jobs row. */
export const BOUNCE_BACK_JOB_KIND = "director-bounce-back";

/**
 * Build the post-bounce CEO escalation card's body — surfaces BOTH diagnoses (original + post-bounce)
 * so the CEO can decide manually. The corresponding notification stamps `metadata.bounced_back_depth=2`
 * + `metadata.diagnoses=[original, post-bounce]` (depth-cap hard rail; the UI hides Send-back).
 */
export function reEscalateAfterBounceBody(args: { originalDiagnosis: string; postBounceDiagnosis: string; ceoNote: string | null }): string {
  const note = (args.ceoNote ?? "").trim();
  return [
    "🛠️ Ada (Platform/DevOps Director) re-escalated this after your bounce-back:",
    "",
    "Your bounce-back note:",
    note ? `“${note.slice(0, 500)}”` : "(none)",
    "",
    "Post-bounce diagnosis:",
    args.postBounceDiagnosis.slice(0, 1800),
    "",
    "Original diagnosis (before the bounce):",
    args.originalDiagnosis.slice(0, 1800),
    "",
    "Bounce depth = 2 (cap). No further bounce — this is the CEO's call.",
  ]
    .join("\n")
    .slice(0, 4000);
}
