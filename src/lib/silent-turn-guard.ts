/**
 * silent-turn-guard — Pure runtime predicate for "did this playbook exec turn actually reach the
 * customer, or was it silent?" Mirrors [[tickets-read]] `buildTurnTimeline`'s READ-side `silentTurn`
 * diagnostic, but this variant runs INSIDE the unified ticket handler
 * (src/lib/inngest/unified-ticket-handler.ts) so a silent turn triggers the
 * `escalate_api_failure` holding-message + Slack path instead of just being observable after the
 * fact.
 *
 * Why this exists (docs/brain/specs/post-resolution-inbound-reroute-and-silent-turn-guard.md
 * § Phase 2, Melissa/eca3f43b): after June resolved the ticket with an in-flight return, a later
 * customer reply resumed the stale pre-escalation refund playbook. The playbook found nothing to
 * do, tried to cancel her subscription (it FAILED), and — crucially — sent the customer ZERO
 * customer-facing text. The playbook exec path could conclude with:
 *   (a) A dead resume — action=complete or MAX_AUTO_ADVANCE-hit advance, no response ever sent
 *       (no customer-facing text, no escalation raised) — the class Melissa hit; and
 *   (b) A failed mutation — e.g. `appstleSubscriptionAction` throws, the step returns without a
 *       response AND without action='escalate_api_failure' (a plausible executor bug that the
 *       runtime guard STILL catches) so an error is dangling with no reply and no escalation.
 * Both must escalate with a holding message so no customer is ever left in silence. Measured:
 * 5 of 13 backstopped tickets ended silent before this shipped.
 *
 * Kept pure (no DB, no imports from the runtime handler) so the handler passes booleans + a final-
 * action + a final-error string and a unit test can exercise every reason (see
 * silent-turn-guard.test.ts). The handler's callsite (the post-auto-advance guard) reads:
 *   const verdict = detectSilentTurn({
 *     responseSent, escalationRaised, cancelled, finalAction: advResult.action, finalError: advResult.error ?? null,
 *   });
 *   if (verdict.silent) { runEscalateApiFailureHoldingMessage(verdict.reason, verdict.note); }
 */

/** The two ways a playbook-exec turn can conclude WITHOUT reaching the customer. */
export type SilentTurnReason =
  | "dead_playbook_resume"       // No response ever produced + no escalation raised; the exec
                                 //  concluded with action=complete OR the auto-advance loop
                                 //  hit the MAX_AUTO_ADVANCE ceiling with no reply — the class
                                 //  Melissa/eca3f43b hit when a stale post-resolution playbook
                                 //  wrongly resumed.
  | "playbook_mutation_failed";  // The exec produced a non-empty `error` field (a subscription
                                 //  or refund mutation threw / returned an error) AND still
                                 //  concluded without a response or an escalation. Guards
                                 //  against an executor bug where a mutation failure fails to
                                 //  flip action='escalate_api_failure' — the runtime guard
                                 //  still short-circuits it into the holding-message path.

/** Return shape: silent=false when the guard passes; silent=true carries the reason + a
 * concise plain-English note the caller uses for the sysNote + Slack payload. */
export type SilentTurnVerdict =
  | { silent: false }
  | { silent: true; reason: SilentTurnReason; note: string };

/**
 * Inputs to the guard. The unified handler tracks each of these across the exec-playbook-step +
 * auto-advance loop and hands them to the predicate ONCE at the end of the block.
 */
export interface SilentTurnInputs {
  /** Any customer-facing external reply was sent via `sendWithDelay` during this turn. */
  responseSent: boolean;
  /** The `escalate_api_failure` branch already fired its own holding-message + Slack path. */
  escalationRaised: boolean;
  /** The turn was aborted mid-exec because a newer customer message arrived (`newerActivity`). */
  cancelled: boolean;
  /** The last `PlaybookExecResult.action` (or null when the playbook path did not run). */
  finalAction: "respond" | "advance" | "complete" | "stand_firm" | "escalate_api_failure" | null;
  /** The last `PlaybookExecResult.error` field (or null when no error string was recorded). */
  finalError: string | null;
}

/**
 * The exact holding-message string the `escalate_api_failure` branch sends today. Exported so
 * the silent-turn escape hatch (a second callsite of the same rail) sends the byte-identical
 * copy and a test can pin the coupling. Kept in the pure module so the handler doesn't invent a
 * second variant that would drift.
 */
export const SILENT_TURN_HOLDING_MESSAGE =
  "I need a little time to work on this and I'll get back to you.";

/**
 * Pure predicate. Given the tracked exec-turn signals, decide whether the handler must escalate
 * with a holding message before returning. Order of precedence:
 *   1. `cancelled`       — the turn was superseded by a newer inbound; a fresh turn will handle
 *                          the customer. Never treat as silent.
 *   2. `responseSent`    — the customer heard back. Never treat as silent.
 *   3. `escalationRaised`— the existing escalate_api_failure rail already sent the holding
 *                          message + Slack ping. Never treat as silent (would double-send).
 *   4. `finalError` set  — the exec carried an error string but landed silent → the mutation-
 *                          failed reason; the note echoes the error verbatim (capped) so the
 *                          sysNote + Slack payload names the concrete failure.
 *   5. Otherwise         — dead resume; note names the exec's final action so a reader can
 *                          distinguish a MAX_AUTO_ADVANCE-hit advance from a silent complete.
 */
export function detectSilentTurn(inputs: SilentTurnInputs): SilentTurnVerdict {
  if (inputs.cancelled) return { silent: false };
  if (inputs.responseSent) return { silent: false };
  if (inputs.escalationRaised) return { silent: false };
  if (inputs.finalError && inputs.finalError.trim().length > 0) {
    return {
      silent: true,
      reason: "playbook_mutation_failed",
      note: `playbook mutation failed silently (no response, no escalation): ${inputs.finalError.trim().slice(0, 300)}`,
    };
  }
  const actionLabel = inputs.finalAction ?? "unknown";
  return {
    silent: true,
    reason: "dead_playbook_resume",
    note: `playbook exec concluded silently on action=${actionLabel} (no customer-facing response, no escalation)`,
  };
}
