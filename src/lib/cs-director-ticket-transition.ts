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

function closeAndDeescalatePatch(now: string): Record<string, unknown> {
  return {
    status: "closed",
    resolved_at: now,
    closed_at: now,
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
    assigned_to: null,
    updated_at: now,
  };
}

function deescalateOnlyPatch(now: string): Record<string, unknown> {
  return {
    escalated_at: null,
    escalated_to: null,
    escalation_reason: null,
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
      if (remedyClosesTicket(input.remedy)) {
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
