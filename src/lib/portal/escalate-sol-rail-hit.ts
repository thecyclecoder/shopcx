/**
 * Escalate a portal-error ticket to June's triage-escalation lane when Sol hits her leash.
 *
 * Phase 3 of [[../../../docs/brain/specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]].
 * On a portal-error first-touch (`agent_jobs.instructions.reason === "portal_error"`, the Phase-1 enqueue
 * shape from [[./enqueue-sol-first-touch]]), when Sol returns `{"status":"needs_human","reason":"..."}` —
 * i.e. she can't resolve within her leash (a judgment call / an approval beyond her authority / a
 * remediation that keeps failing) — the worker (deterministic Node — the only mutator) escalates the
 * ticket to the routine lane the [[../inngest/triage-escalations]] cron picks up:
 *   `escalated_at = now`, `escalated_to = null`, `escalation_reason = 'sol_portal_rail_hit: <sol reason>'`.
 *
 * That is the SAME third-rung escalation ladder (orchestrator/Sol → triage → CS Director June → founder);
 * Phase 3's contribution is just seating Sol on the FIRST rung of the portal path. The June review reads
 * the ticket + the durable `ticket_directions` row Sol authored (or the last live one on a re-session) +
 * Sol's attempts from `ticket_resolution_events` + `ticket_messages` — nothing is bundled onto the
 * escalate call itself; the escalation carries the reason string and June's session picks up the rest.
 *
 * Guards (Learning #2 — confirming predicate at the mutating action point, not a coarser proxy):
 *   - `.eq('workspace_id', ws)` — cross-workspace ticket-id collision can't overwrite state.
 *   - `.is('escalated_at', null)` — a compare-and-set that refuses to overwrite an existing escalate
 *     (e.g. a prior `sol_resession_cap_hit` from [[../inflection-detector]] `reSessionSol`). The first
 *     escalate wins; subsequent Sol rail-hits become a no-op instead of clobbering the audit trail.
 *   - `.select('id')` — assert exactly one row transitioned; zero rows → the helper returns
 *     `{escalated:false, reason:'already_escalated'|'not_found'}` so the caller surfaces a clean audit
 *     line instead of silently swallowing the state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Stable prefix on `tickets.escalation_reason` for a Sol portal rail-hit. The June review reads this
 *  prefix off the ticket to know which rung the escalate came from. */
export const SOL_PORTAL_RAIL_HIT_REASON_PREFIX = "sol_portal_rail_hit";

export interface EscalateInput {
  workspace_id: string;
  ticket_id: string;
  /** The `reason` line Sol returned in her `{"status":"needs_human","reason":"..."}` verdict. Used
   *  verbatim as the tail of `escalation_reason`; June's session reads this to see WHY Sol punted. */
  sol_reason: string;
}

export interface EscalateOutcome {
  escalated: boolean;
  /** Populated on `escalated: false` — either the ticket was already escalated (compare-and-set won by
   *  a prior write) or the ticket_id/workspace_id pair didn't resolve. Populated on `escalated: true`
   *  with the exact `escalation_reason` written to the row so the caller can log it. */
  reason: string;
}

/**
 * Build the exact `escalation_reason` written to the ticket. Trims the Sol reason and prefixes with
 * `sol_portal_rail_hit:` so a grep against the DB or a June-review log line surfaces every portal
 * rail-hit uniformly. When Sol's reason is empty/whitespace we fall back to a stable placeholder so
 * the escalation_reason column is never blank (`ticket_resolution_events`'s reasoning column is a
 * `text` — a blank reason is legal but noise on a human-facing view).
 */
export function buildSolPortalRailHitReason(solReason: string): string {
  const trimmed = (solReason || "").trim();
  const tail = trimmed.length > 0 ? trimmed : "(no reason given)";
  return `${SOL_PORTAL_RAIL_HIT_REASON_PREFIX}: ${tail}`;
}

export async function escalateSolPortalRailHit(
  admin: SupabaseClient,
  input: EscalateInput,
): Promise<EscalateOutcome> {
  const escalationReason = buildSolPortalRailHitReason(input.sol_reason);
  const now = new Date().toISOString();

  // Compare-and-set on the ticket. `.is('escalated_at', null)` refuses to overwrite an existing
  // escalate (a prior sol_resession_cap_hit / auto-heal escalate wins). workspace_id-scoped so a
  // cross-workspace ticket_id collision can't cross the boundary. `.select('id')` asserts exactly
  // one row transitioned; zero rows surface the two possible bail states through `reason`.
  const { data: rows, error } = await admin
    .from("tickets")
    .update({
      escalated_at: now,
      escalated_to: null,
      escalation_reason: escalationReason,
      updated_at: now,
    })
    .eq("id", input.ticket_id)
    .eq("workspace_id", input.workspace_id)
    .is("escalated_at", null)
    .select("id");
  if (error) throw error;
  const escalated = ((rows as Array<{ id: string }> | null) ?? []).length === 1;
  if (escalated) {
    return { escalated: true, reason: escalationReason };
  }

  // Zero rows transitioned. Read the ticket back (workspace_id-scoped) to distinguish "already
  // escalated" (compare-and-set correctly refused) from "row not found" (mis-enqueued / cross-
  // workspace) so the caller can log a specific audit line. Ledger-only read; no mutation.
  const { data: probe } = await admin
    .from("tickets")
    .select("escalated_at")
    .eq("id", input.ticket_id)
    .eq("workspace_id", input.workspace_id)
    .maybeSingle();
  if (!probe) return { escalated: false, reason: "not_found" };
  return { escalated: false, reason: "already_escalated" };
}
