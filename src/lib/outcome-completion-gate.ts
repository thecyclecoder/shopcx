/**
 * outcome-completion-gate — Phase 4 of docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md.
 *
 * The **resolution completion gate**: a ticket cannot auto-resolve while any
 * ticket_required_outcomes row is not `status='verified'`. Sits at the auto-close call sites
 * (primary wire-in: unified-ticket-handler's `message_sent` branch, right where the sonnet
 * orchestrator turn used to unconditionally `setStatus(closed)`), and escalates the ticket
 * NAMING the unfinished items instead. See [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]].
 *
 * Design mirrors the earlier Phase-2/Phase-3 gates:
 *   - `assessOutcomeCompletion` is PURE — deterministic decision over the outcomes list, no
 *     DB call. Testable via node:test with fake outcomes.
 *   - `buildEscalationReason` produces the customer-facing-safe reason string that names
 *     unfinished items. Truncated to 500 chars so it fits in tickets.escalation_reason.
 *   - `assertOutcomesCompleteBeforeClose` is the wire-in — loads outcomes, calls the predicate,
 *     when blocked escalates the ticket via `escalateTicketOnIncompleteOutcomes` and returns
 *     the verdict so the caller can skip its normal close path.
 *
 * Derived-from-ticket 0a9e4d7f (Judy) — the reply promised bag+credit; both failed to run; the
 * ticket auto-resolved anyway because auto-resolve keyed off "reply sent", not "DB items done".
 * This gate makes the invariant enforced: the session doesn't end until the DB items complete
 * and verify.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listRequiredOutcomes,
  type TicketRequiredOutcome,
  type RequiredOutcomeStatus,
} from "./ticket-required-outcomes";

/** One outcome the gate flagged as unfinished. */
export interface UnfinishedOutcome {
  outcome_id: string;
  kind: string;
  description: string;
  /** The status the row was in — pending / done / failed. Never 'verified'. */
  status: Exclude<RequiredOutcomeStatus, "verified">;
  /** Populated only for `status='failed'` rows — surfaces to the escalation reason verbatim. */
  failed_reason?: string;
}

/** Verdict shape mirrors the Phase-3 send guard for callers that compose the two. */
export type OutcomeCompletionVerdict =
  | { ok: true }
  | { ok: false; unfinished_items: UnfinishedOutcome[]; total_count: number };

/**
 * Pure predicate: given a ticket's outcomes list, decide whether the auto-close gate can open.
 *
 * The rule is a strict single-line invariant: EVERY row must be `status='verified'`. A `done`
 * row (executor fired the action but `verifyActionInDB` hasn't confirmed the predicate) is
 * treated the same as `pending` — the message-is-last spec's whole point is that a completion
 * claim requires DB confirmation, not just a handler that returned success. Failed rows are
 * likewise unfinished — a failed action needs human attention, not silent auto-close.
 *
 * Fail-open on an empty list: a ticket with NO required outcomes (customer said "thanks",
 * naked reply-only turn, legacy tickets predating Phase 1) is not held up by this gate.
 * The gate only enforces the invariant when there's something to enforce.
 */
export function assessOutcomeCompletion(
  outcomes: TicketRequiredOutcome[],
): OutcomeCompletionVerdict {
  const unfinished: UnfinishedOutcome[] = [];
  for (const o of outcomes) {
    if (o.status === "verified") continue;
    unfinished.push({
      outcome_id: o.id,
      kind: o.kind,
      description: o.description,
      status: o.status,
      failed_reason: o.failed_reason ?? undefined,
    });
  }
  if (unfinished.length === 0) return { ok: true };
  return { ok: false, unfinished_items: unfinished, total_count: outcomes.length };
}

const ESCALATION_REASON_CAP = 500;

/**
 * Build the human-readable escalation reason for `tickets.escalation_reason`. Names the count,
 * the count-by-status breakdown, and each item's kind + description + status inline. Truncates
 * to 500 chars so the write can never overflow the column — a 40-item ticket is trimmed with
 * a "+N more" tail so the field still fits.
 *
 * Called by `escalateTicketOnIncompleteOutcomes` and by any surface (Improve tab, dashboard
 * notification) that wants to render the same message.
 *
 * Returns "" for an OK verdict — the caller can conditionally include the reason ("if reason
 * then …") without a separate null check.
 */
export function buildEscalationReason(verdict: OutcomeCompletionVerdict): string {
  if (verdict.ok) return "";
  const counts: Record<UnfinishedOutcome["status"], number> = { pending: 0, done: 0, failed: 0 };
  for (const u of verdict.unfinished_items) counts[u.status] += 1;
  const countParts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  const head = `${verdict.unfinished_items.length} required outcome(s) unfinished (${countParts.join(", ")}):`;
  const parts: string[] = [];
  for (const u of verdict.unfinished_items) {
    const failedTail = u.failed_reason ? ` — ${u.failed_reason}` : "";
    parts.push(`${u.kind}[${u.status}] ${u.description}${failedTail}`);
  }
  let body = parts.join("; ");
  const full = `${head} ${body}`;
  if (full.length <= ESCALATION_REASON_CAP) return full;
  // Trim by dropping trailing items and appending a "+N more" tail so the field still fits.
  const suffix = `; +${verdict.unfinished_items.length} more`;
  let kept = 0;
  const kept_parts: string[] = [];
  for (const p of parts) {
    const candidate = `${head} ${kept_parts.concat([p]).join("; ")}${suffix}`;
    if (candidate.length > ESCALATION_REASON_CAP) break;
    kept_parts.push(p);
    kept += 1;
  }
  const truncatedSuffix = `; +${verdict.unfinished_items.length - kept} more`;
  return `${head} ${kept_parts.join("; ")}${truncatedSuffix}`.slice(0, ESCALATION_REASON_CAP);
}

/**
 * The top-level wire-in. Load the ticket's required outcomes, call the pure predicate, and
 * return the verdict. Caller decides what to do on `ok=false` (typically: escalate instead of
 * close). Isolated from the escalate helper so a caller can inspect the verdict without firing
 * a mutation (e.g. a dashboard "why can't this auto-close" tooltip).
 */
export async function assertOutcomesCompleteBeforeClose(input: {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
}): Promise<OutcomeCompletionVerdict> {
  const outcomes = await listRequiredOutcomes(input.admin, input.ticket_id, {
    workspace_id: input.workspace_id,
  });
  return assessOutcomeCompletion(outcomes);
}

/**
 * Escalate a ticket whose completion gate is BLOCKED. Compare-and-set on the ticket's current
 * status so a racing writer that closed the ticket first doesn't get overwritten (learning #5 —
 * re-assert the read-time predicate in the write). `status='open'` + `escalated_at=now()` +
 * `escalation_reason=<named unfinished items>` — the routine picks it up from the escalated
 * queue instead of the ticket sitting silently closed on unfinished work.
 *
 * Returns whether the write actually landed. `false` means either the CAS lost (ticket was
 * already progressed by another writer) or the verdict was ok=true (nothing to escalate).
 */
export async function escalateTicketOnIncompleteOutcomes(input: {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  verdict: OutcomeCompletionVerdict;
  /**
   * The status the ticket is expected to currently be in — the compare-and-set match. Callers
   * pass whatever their pre-close read observed (typically 'open' or 'pending'); leave undefined
   * to accept any current status.
   */
  from_status?: string;
}): Promise<boolean> {
  if (input.verdict.ok) return false;
  const reason = buildEscalationReason(input.verdict);
  let q = input.admin
    .from("tickets")
    .update({
      status: "open",
      escalated_at: new Date().toISOString(),
      escalation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.ticket_id)
    .eq("workspace_id", input.workspace_id);
  if (input.from_status) q = q.eq("status", input.from_status);
  const { data, error } = await q.select("id");
  if (error) return false;
  const rows = (data ?? []) as Array<{ id: string }>;
  return rows.length === 1;
}
