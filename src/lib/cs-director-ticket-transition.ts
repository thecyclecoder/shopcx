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

export type CsDirectorDecision =
  | "approve_remedy"
  | "author_spec"
  | "escalate_founder"
  | "close_no_action"
  /**
   * `message_only` — Phase 3 of cs-director-call-loop-guard-and-message-only-remedy. June sends a
   * customer-facing explanation and RESOLVES the ticket (not parks it), with no money or account
   * mutation involved. The transition maps it to `close_and_deescalate` — the same terminal patch
   * `author_spec` + a resolving `approve_remedy` land on — so the ticket cannot feed the loop
   * Phase 1 and 2 close.
   */
  | "message_only";

export type CsDirectorTransitionActionKey =
  | "close_and_deescalate"
  | "deescalate_only"
  | "keep_escalated_ceo_owned"
  | "keep_escalated_needs_attention"
  /**
   * Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation. When the
   * pre-patch ticket carries a `CEO — awaits founder ruling:` escalation_reason (stamped by an
   * earlier `escalate_founder` verdict) and this session's verdict would otherwise clear it
   * (`close_and_deescalate` / `deescalate_only`), the transition is DOWNGRADED to this key so
   * the escalation stays put and the ticket stays open. The single exception is an
   * `approve_remedy` that RESOLVED the customer's issue (`remedyResolved===true`) — a resolved
   * issue retires its own escalation, same principle as
   * an-escalation-retires-itself-when-the-condition-it-reported-self-heals.
   * Motivating case: ticket c969f235 (G esposito, 2026-08-18). June ruled `escalate_founder` at
   * 15:53, a second June session ruled `author_spec` at 16:36, the transition closed + cleared
   * the founder escalation with no card + no note, and the customer's 16:53 reply reopened the
   * ticket unescalated — 19h invisible to the founder on a $1,628-LTV customer.
   */
  | "keep_escalated_founder_ruling_pending"
  | "noop";

/**
 * Phase 2 of cs-director-spec-claim-must-match-the-actual-write — the OUTCOME `handleAuthorSpec`
 * returned, threaded through the transition decision so an `author_spec` verdict CLOSES the ticket
 * only when the specs SDK confirmed the write. On ticket 2b7ea029 the pre-Phase-2 transition
 * unconditionally closed + de-escalated on `author_spec`, and the phantom-spec close was the
 * irreversible half: nobody revisits a closed, de-escalated ticket, so the missing spec was
 * invisible for a day. When the write failed the ticket must stay OPEN + ESCALATED + flagged
 * needs_attention so it lands back in the queue instead of disappearing.
 */
export interface CsDirectorAuthorSpecOutcome {
  /**
   * True iff the specs SDK confirmed the write (`applyBoxCsDirectorCall` returned ok + no
   * needs_attention). Named `specWritten` — not `ok` — because the whole point of Phase 2 is that
   * the transition gate must key off "did the spec ACTUALLY get written?" and NOT off any coarser
   * proxy ("did the handler return without throwing?"). The name is the contract: `specWritten`
   * is the ONLY signal that authorizes closing + de-escalating the ticket on an `author_spec`
   * verdict; any falsy value (false OR undefined for a caller that failed to thread it) MUST
   * leave the ticket open + escalated. Grepped in the pre-flight acceptance check as the
   * distinguishing token from the pre-Phase-2 shape (which had no outcome plumbing at all).
   */
  specWritten: boolean;
  reason?: string;
}

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
  /**
   * Phase 2 of cs-director-spec-claim-must-match-the-actual-write — the outcome of the
   * `handleAuthorSpec` executor call. Only meaningful for `decision='author_spec'`:
   *  - `specWritten: true`   → close + de-escalate (the write actually landed; nothing more to do).
   *  - `specWritten: false`  → keep escalated + stamp escalation_reason with `needs_attention` so
   *                            the ticket lands back in the queue instead of disappearing on a
   *                            phantom close.
   *  - `undefined`           → legacy back-compat only (a stale caller that predates Phase 2).
   *                            Treated as a confirmed write so the shipped `close_and_deescalate`
   *                            behavior is unchanged. The shipped `runCsDirectorCallJob` call site
   *                            ALWAYS threads the outcome.
   */
  authorSpecOutcome?: CsDirectorAuthorSpecOutcome | null;
  /** Resolved workspace-owner user_id, when the caller can supply it. Optional. */
  ceoUserId?: string | null;
  /**
   * Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation — the ticket's
   * PRE-patch escalation state, threaded in by `runCsDirectorCallJob` (Phase 2). When
   * `escalation_reason` starts with the `CEO — awaits founder ruling:` prefix an earlier
   * `escalate_founder` verdict stamped, this session's verdict is DOWNGRADED to
   * `keep_escalated_founder_ruling_pending` if it would otherwise clear the escalation — a later
   * verdict cannot silently retire a founder page that has never been ruled on.
   *
   * OPTIONAL — an absent value means the caller could not read the row and MUST behave exactly
   * like today (no downgrade), so a read failure never strands a ticket escalated forever
   * (the runner treats a read error as `priorEscalation: null` for exactly this reason).
   */
  priorEscalation?: { escalated_to: string | null; escalation_reason: string | null } | null;
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

/**
 * Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation — the deterministic
 * escalation_reason prefix `escalate_founder` stamps to mark a ticket as "AWAITING the CEO's
 * ruling." Exported so the reader (`isAwaitingFounderRuling`) and the writer
 * (`ceoOwnedEscalationReason`) key on the SAME literal — the two cannot drift apart.
 */
export const FOUNDER_RULING_PREFIX = "CEO — awaits founder ruling:";

function ceoOwnedEscalationReason(reasoning: string): string {
  const trimmed = (reasoning || "").trim();
  const suffix = trimmed.length > 0 ? trimmed : "see cs-director verdict";
  // Cap at 400 chars — a `tickets.escalation_reason` free-text column is small and the full
  // reasoning lives on `director_activity` + the internal note the Phase 1 write dropped.
  return `${FOUNDER_RULING_PREFIX} ${suffix}`.slice(0, 400);
}

/**
 * Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation — the pure predicate
 * that answers "is a founder ruling still pending on this ticket?" Keyed on `escalation_reason`
 * (not `escalated_to`) because `escalated_to` is also set by `raiseJuneRemedyApproval` and other
 * lanes, while the reason prefix is the exact marker THIS module writes when `escalate_founder`
 * fires. A ticket whose reason line starts with `CEO — awaits founder ruling:` was escalated by
 * an earlier June verdict AND has not yet been ruled on by the CEO — the invariant a later
 * verdict must not silently violate.
 */
export function isAwaitingFounderRuling(
  prior: { escalation_reason: string | null } | null | undefined,
): boolean {
  const reason = prior?.escalation_reason;
  if (typeof reason !== "string" || reason.length === 0) return false;
  return reason.startsWith(FOUNDER_RULING_PREFIX);
}

/**
 * Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation — the patch a
 * downgraded transition applies: clear the pre-escalation playbook fields (the escalation itself
 * supersedes the playbook the same way a resolution does) + stamp `updated_at`, and NOTHING else.
 * The ticket stays open (no `status` / `closed_at` / `resolved_at` / `assigned_to`) and stays
 * escalated (no `escalated_at` / `escalated_to` / `escalation_reason` clear). The founder ruling
 * has not landed — the founder page cannot be silently retired.
 */
function founderRulingPendingPatch(now: string): Record<string, unknown> {
  return {
    ...PLAYBOOK_CLEAR_FIELDS,
    updated_at: now,
  };
}

/**
 * Phase 2 of cs-director-spec-claim-must-match-the-actual-write — build the escalation_reason a
 * FAILED author_spec write stamps on the ticket. Names the concrete failure class from
 * `handleAuthorSpec` (`spec_seed_missing_*`, `ticket_id_unresolved`,
 * `author_spec_write_returned_false`, `author_spec_threw`, `handler_threw`) so a CS agent scanning
 * the queue immediately sees WHY the ticket is back in-queue instead of resolved. Caps at 400 chars
 * to fit the free-text column; the full reasoning lives on `director_activity` + the Phase-1
 * internal note the runner already dropped.
 */
function needsAttentionEscalationReason(reason: string | undefined): string {
  const cleaned = (reason ?? "").trim();
  const token = cleaned.length > 0 ? cleaned : "unknown_reason";
  return `author_spec FAILED (${token}) — no spec was written; ticket needs human review`.slice(0, 400);
}

/**
 * Decide the per-verdict patch to apply to the ticket. The runner then executes it as a compare-
 * and-set (`.eq("id", ticketId).eq("workspace_id", …).select("id")`) so an async race can't
 * overwrite a ticket that has moved on. Never throws; unknown decisions become a `noop` patch so
 * the runner treats them as a safety fall-through rather than corrupting the row.
 */
export function decideCsDirectorTicketTransition(input: CsDirectorTransitionInput): CsDirectorTicketTransition {
  const raw = decideRawTransition(input);
  // Phase 1 of a-cs-director-verdict-cannot-clear-an-unruled-founder-escalation — the founder-
  // escalation-is-sticky invariant: while `escalation_reason` still carries the
  // `CEO — awaits founder ruling:` prefix an earlier June `escalate_founder` verdict stamped,
  // any transition that would CLEAR that escalation gets downgraded to a preserving one so the
  // founder page cannot be silently retired by a later verdict that never ruled on it. The single
  // exception: an `approve_remedy` that the mutator actually RESOLVED (fired the actions +
  // delivered the reply) — a resolved issue retires its own escalation (same principle as the
  // shipped an-escalation-retires-itself-when-the-condition-it-reported-self-heals spec). The
  // downgrade is scoped to the two escalation-clearing action keys — `keep_escalated_ceo_owned` /
  // `keep_escalated_needs_attention` / `noop` are already preserving and pass through untouched.
  const clearsEscalation =
    raw.action_key === "close_and_deescalate" || raw.action_key === "deescalate_only";
  const remedyRetires = input.decision === "approve_remedy" && input.remedyResolved === true;
  if (clearsEscalation && !remedyRetires && isAwaitingFounderRuling(input.priorEscalation)) {
    return {
      action_key: "keep_escalated_founder_ruling_pending",
      patch: founderRulingPendingPatch(input.now),
    };
  }
  return raw;
}

function decideRawTransition(input: CsDirectorTransitionInput): CsDirectorTicketTransition {
  switch (input.decision) {
    case "author_spec": {
      // Phase 2 of cs-director-spec-claim-must-match-the-actual-write — close ONLY on a confirmed
      // write. Ticket 2b7ea029 was closed + de-escalated though no spec landed, and the
      // irreversibility of the close hid the missing spec for a day. A failed write leaves the
      // ticket OPEN + ESCALATED + escalation_reason stamped with the failure reason so it lands
      // back in the queue instead of disappearing. Playbook fields are NOT cleared — this is not a
      // resolution-side transition (June's structural fix never landed; a customer follow-up may
      // still legitimately resume the pre-escalation lane after a human resolves the failed write).
      //
      // june-authored-specs-carry-machine-runnable-checks Phase 2 — a failed author_spec is now
      // ESCALATED TO THE CEO (`escalated_to = ceoUserId` when resolvable), the same treatment
      // `escalate_founder` gets, so the ticket lands in the founder's escalated view instead of an
      // "escalated but owned by nobody" limbo (the exact failure mode Yvonne Carreon's ticket sat
      // in for 2.6 days). The CEO card the runner mints for this branch is the human-visible
      // surface that pairs with this ownership stamp.
      const outcome = input.authorSpecOutcome;
      // Read the `specWritten` predicate off the outcome — the ONLY signal that authorizes closing
      // + de-escalating an author_spec verdict. `outcome === undefined` is the legacy back-compat
      // path (a pre-Phase-2 caller); the shipped runCsDirectorCallJob always threads the outcome.
      const specWritten = outcome ? outcome.specWritten === true : true;
      if (outcome && specWritten === false) {
        const patch: Record<string, unknown> = {
          escalation_reason: needsAttentionEscalationReason(outcome.reason),
          updated_at: input.now,
        };
        // Stamp the CEO as the escalation owner when we can resolve them, so the ticket surfaces
        // in the founder-escalated view alongside every other escalate_founder verdict.
        if (input.ceoUserId) patch.escalated_to = input.ceoUserId;
        return { action_key: "keep_escalated_needs_attention", patch };
      }
      // Confirmed write (specWritten === true) — OR the legacy back-compat path where the caller
      // didn't thread the outcome at all (pre-Phase-2 unit tests) — closes + de-escalates + clears
      // the pre-escalation playbook the same way the shipped Phase-1 transition did.
      return { action_key: "close_and_deescalate", patch: closeAndDeescalatePatch(input.now) };
    }
    // close_no_action — June investigated, the handling was already correct, and there is NO
    // in-leash remedy AND no genuine founder judgment to make (a phantom charge we can't locate
    // and the customer was already asked for identifying info; a "nothing to do" ticket). Close +
    // de-escalate + unassign — do NOT page the founder for a no-op. See cs-director § close_no_action.
    case "close_no_action":
      return { action_key: "close_and_deescalate", patch: closeAndDeescalatePatch(input.now) };
    // message_only (Phase 3 of cs-director-call-loop-guard-and-message-only-remedy) — June sent
    // a customer-facing explanation and there is NO account/money mutation to await. The message
    // IS the resolution. Same close+clear patch as close_no_action / author_spec so the ticket
    // does not linger open (which would let the CS auto-router feed the loop Phase 1 caps).
    case "message_only":
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
