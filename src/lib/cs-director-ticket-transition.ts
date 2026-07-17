/**
 * cs-director-ticket-transition — Pure per-verdict `tickets` patch builder for Phase 2 of
 * cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict.
 *
 * Phase 1 wrote an internal note per verdict; before this shipped, the ticket state itself did
 * not change — an `author_spec` verdict left the ticket open + escalated + note-less (Phase 1
 * closed the note-less gap; this phase closes the open+escalated+no-owner gap). The invariant
 * this helper enforces: NEVER leave a ruled-on ticket in the open+escalated+no-owner state.
 *
 * Per-verdict shape (spec Phase 2):
 *   author_spec       → close + de-escalate + unassign (customer side is done; the structural
 *                       fix is tracked on its own spec).
 *   approve_remedy    → if the RemedyPlan explicitly signals NO further customer reply is
 *                       needed, close + de-escalate + unassign; otherwise de-escalate only, so
 *                       the ticket is no longer stranded in escalation while the Phase-2
 *                       applyBoxCsDirectorCall (third-rung mutator) fires the remedy and, in
 *                       turn, sends the customer reply that resolves the thread.
 *   escalate_founder  → keep escalated but record that it now AWAITS THE CEO. When the caller
 *                       can resolve the workspace owner's `user_id`, we also stamp it on
 *                       `escalated_to` so the ticket is OWNED by the founder rather than
 *                       stranded on the routine's default lane.
 *
 * Both resolution-side patches (`close_and_deescalate` + `deescalate_only`) additionally clear
 * `active_playbook_id` + `playbook_step` + `playbook_exceptions_used` so a June-resolved ticket
 * cannot resume a stale pre-escalation playbook on a later customer follow-up
 * (docs/brain/specs/post-resolution-inbound-reroute-and-silent-turn-guard.md § Phase 1 —
 * Melissa/eca3f43b: the stale refund playbook re-ran after June closed with an in-flight return,
 * tried a silent cancel, and sent the customer nothing). `escalate_founder` deliberately leaves
 * the playbook alone — the founder ruling may still fold back into the pre-escalation lane.
 *
 * Kept pure (no DB, no imports from the runtime worker) so `runCsDirectorCallJob` can call it +
 * pass the patch to a straight `tickets.update` with a compare-and-set guard, and so a unit
 * test can exercise every verdict shape (see cs-director-ticket-transition.test.ts).
 *
 * See docs/brain/libraries/cs-director.md loop-closure contract + Phase 2 verification bullet.
 */

export type CsDirectorDecision = "approve_remedy" | "author_spec" | "escalate_founder" | "close_no_action";

export type CsDirectorTransitionActionKey =
  | "close_and_deescalate"
  | "deescalate_only"
  | "keep_escalated_ceo_owned"
  | "noop";

export interface CsDirectorTransitionInput {
  decision: CsDirectorDecision;
  reasoning: string;
  remedy?: Record<string, unknown> | null;
  /**
   * True when the Phase-2 mutator ACTUALLY executed the remedy cleanly AND
   * delivered the resolving customer reply (applyBoxCsDirectorCall returned
   * ok, not needs_attention, not awaiting_founder_approval). An approve_remedy
   * that fired its actions + sent the reply has RESOLVED the customer's issue —
   * the ticket should close, not linger open. Without this signal the helper
   * only de-escalated, leaving every remedy-resolved ticket stuck open (ticket
   * eca3f43b). The runner is the sole source of this flag; a test passes it
   * explicitly. Absent/false → conservative de-escalate-only (a parked/failed
   * remedy must never auto-close).
   */
  remedyResolved?: boolean;
  /** Resolved workspace-owner user_id, when the caller can supply it. Optional. */
  ceoUserId?: string | null;
  /** ISO timestamp used for `updated_at` / `closed_at` / `resolved_at` — passed in so tests are deterministic. */
  now: string;
}

export interface CsDirectorTicketTransition {
  patch: Record<string, unknown>;
  action_key: CsDirectorTransitionActionKey;
}

/**
 * Does the RemedyPlan explicitly signal that no further customer reply is needed? The RemedyPlan
 * is `Record<string, unknown>` today (a formal type will land alongside the Phase-2 third-rung
 * mutator that consumes it), so this predicate checks the plausible field names an author would
 * use. Conservative default: if none of the signals are set, we assume a reply IS pending.
 */
function remedyClosesTicket(remedy: Record<string, unknown> | null | undefined): boolean {
  if (!remedy) return false;
  if (remedy.needs_customer_reply === false) return true;
  if (remedy.customer_reply === false) return true;
  if (remedy.close_ticket === true) return true;
  if (remedy.resolves_ticket === true) return true;
  const status = typeof remedy.status === "string" ? remedy.status.toLowerCase() : "";
  if (status === "closed" || status === "resolved") return true;
  return false;
}

/**
 * A CS-director resolution — an `approve_remedy` June actually executed OR a `close_no_action`
 * OR an `author_spec` — supersedes the ticket's active playbook the same way an external human-
 * agent reply does: the playbook was the pre-escalation lane, June's resolution is the current
 * lane, and a later customer follow-up must NOT resume the stale pre-escalation playbook.
 * See docs/brain/specs/post-resolution-inbound-reroute-and-silent-turn-guard.md § Phase 1
 * (derived-from Melissa/eca3f43b) + [[../inngest/unified-ticket-handler]] check-playbook guard.
 * Both resolution-side patches (`close_and_deescalate` + `deescalate_only`) include these
 * clearers idempotently — safe on a ticket that never carried a playbook.
 */
const PLAYBOOK_CLEAR_FIELDS = {
  active_playbook_id: null,
  playbook_step: 0,
  playbook_exceptions_used: 0,
} as const;

function closeAndDeescalatePatch(now: string): Record<string, unknown> {
  return {
    status: "closed",
    resolved_at: now,
    closed_at: now,
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
    assigned_to: null,
    ...PLAYBOOK_CLEAR_FIELDS,
    updated_at: now,
  };
}

function deescalateOnlyPatch(now: string): Record<string, unknown> {
  return {
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
    ...PLAYBOOK_CLEAR_FIELDS,
    updated_at: now,
  };
}

function ceoOwnedEscalationReason(reasoning: string): string {
  const trimmed = (reasoning || "").trim();
  const suffix = trimmed.length > 0 ? trimmed : "see cs-director verdict";
  // Cap at 400 chars — a `tickets.escalation_reason` free-text column is small and the full
  // reasoning lives on `director_activity` + the internal note the Phase 1 write dropped.
  return `CEO — awaits founder ruling: ${suffix}`.slice(0, 400);
}

/**
 * Decide the per-verdict patch to apply to the ticket. The runner then executes it as a compare-
 * and-set (`.eq("id", ticketId).eq("workspace_id", …).select("id")`) so an async race can't
 * overwrite a ticket that has moved on. Never throws; unknown decisions become a `noop` patch so
 * the runner treats them as a safety fall-through rather than corrupting the row.
 */
export function decideCsDirectorTicketTransition(input: CsDirectorTransitionInput): CsDirectorTicketTransition {
  switch (input.decision) {
    case "author_spec":
      return { action_key: "close_and_deescalate", patch: closeAndDeescalatePatch(input.now) };
    // close_no_action — June investigated, the handling was already correct, and there is NO
    // in-leash remedy AND no genuine founder judgment to make (a phantom charge we can't locate
    // and the customer was already asked for identifying info; a "nothing to do" ticket). Close +
    // de-escalate + unassign — do NOT page the founder for a no-op. See cs-director § close_no_action.
    case "close_no_action":
      return { action_key: "close_and_deescalate", patch: closeAndDeescalatePatch(input.now) };
    case "approve_remedy":
      // Close when the remedy explicitly signals no reply is pending OR the
      // mutator actually resolved it (fired the actions + delivered the reply).
      // The remedy IS the final CS resolution — a return pipeline / customer
      // follow-up reopens the ticket if needed. Only de-escalate (leave open)
      // when the remedy hasn't resolved: parked for founder approval, failed,
      // or genuinely awaiting a further customer reply.
      if (remedyClosesTicket(input.remedy) || input.remedyResolved) {
        return { action_key: "close_and_deescalate", patch: closeAndDeescalatePatch(input.now) };
      }
      return { action_key: "deescalate_only", patch: deescalateOnlyPatch(input.now) };
    case "escalate_founder": {
      const patch: Record<string, unknown> = {
        escalation_reason: ceoOwnedEscalationReason(input.reasoning),
        updated_at: input.now,
      };
      if (input.ceoUserId) patch.escalated_to = input.ceoUserId;
      return { action_key: "keep_escalated_ceo_owned", patch };
    }
    default:
      return { action_key: "noop", patch: {} };
  }
}
