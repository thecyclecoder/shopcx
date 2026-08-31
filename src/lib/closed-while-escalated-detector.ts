/**
 * closed-while-escalated-detector — Phase 2 of
 * [[../../docs/brain/specs/closing-a-ticket-must-not-destroy-an-active-escalation]].
 *
 * READ-ONLY detector. Surfaces tickets whose ticket_messages thread shows a founder / agent
 * escalation note but whose row now sits `status='closed'` with the escalation columns cleared
 * (`escalated_to IS NULL`) — the exact pattern that made 9 cases invisible in 21 days before the
 * 2026-08-28 investigation. Ticket 6b0cd91c (Denise Richling): escalated 17:38, auto-closed 21:22,
 * $102.33 duplicate charge unrefunded; only surviving trace was a CEO approval card.
 *
 * Phase 1 stopped the CLASS from silently recurring on new writes ([[tickets-mutate]] `closeTicket`
 * no longer blanket-clears the triple; [[inngest/unified-ticket-handler]] `setStatus` compare-and-
 * sets `.is('escalated_to', null)` on the auto-close). Phase 2 is the STANDING check that catches a
 * regression if the class re-emerges through a path the Phase-1 guard doesn't cover (a raw update,
 * a new code path, a data migration) — count-only, no auto-reopen (a settled ticket SHOULD be
 * closed; the signal is for closes that happened while a decision was still outstanding).
 *
 * Ground query mirrors the 2026-08-28 investigation:
 *   SELECT t.id FROM tickets t
 *     JOIN ticket_messages m ON m.ticket_id = t.id
 *    WHERE t.workspace_id = $1
 *      AND t.status = 'closed'
 *      AND t.escalated_to IS NULL
 *      AND m.body ILIKE '%[System] Escalating.%'   -- the escalate() sysNote in unified-ticket-handler
 *      AND (since IS NULL OR t.closed_at >= since);
 *
 * Registered as a DB probe (`tickets_closed_while_escalated_count`) so Control Tower / spec-check
 * runners can call it without inventing SQL — the runner NEVER runs user-supplied SQL, only
 * allowlisted probes ([[spec-check-db-probes]]).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The escalation-note marker written by [[inngest/unified-ticket-handler]] `escalate` (line ~567):
 *   `[System] Escalating. ${suggestion}`
 * A ticket_messages row containing this string is the durable trace that the ticket WAS routed
 * through the escalation path — regardless of what the tickets row currently shows.
 */
export const ESCALATION_NOTE_MARKER = "[System] Escalating.";

export interface ClosedWhileEscalatedRow {
  ticket_id: string;
  closed_at: string | null;
  escalation_reason: string | null;
}

export interface ClosedWhileEscalatedReport {
  count: number;
  /**
   * Up to `sampleLimit` id + closed_at rows for the surface layer (a Control Tower tile or a
   * dashboard link). Not exhaustive — the count is the truth-signal, the sample is human context.
   */
  sample: ClosedWhileEscalatedRow[];
}

/**
 * READ-ONLY. Returns the count (and up to `sampleLimit` rows) of tickets in `workspaceId` that
 * carry an escalation-note trace in ticket_messages but sit `status='closed'` with the escalation
 * columns cleared. Optional `sinceIso` narrows to closes-since; omit for the full history.
 *
 * NEVER writes. NEVER reopens. The signal is a count for a Control Tower tile / detector; a human
 * decides whether any given row deserves reopening.
 *
 * Post-Phase-1 (new closes preserve the triple), this count should PLATEAU on legacy rows and NOT
 * grow on new closes. A rising count on windowed (sinceIso ≥ Phase-1 ship date) queries is the
 * regression signal.
 */
export async function closedWhileEscalated(
  admin: SupabaseClient,
  opts: { workspaceId: string; sinceIso?: string | null; sampleLimit?: number },
): Promise<ClosedWhileEscalatedReport> {
  const workspaceId = opts.workspaceId;
  const sinceIso = opts.sinceIso ?? null;
  const sampleLimit = Math.max(0, Math.min(50, opts.sampleLimit ?? 10));

  // Step 1: pull ticket_ids in this workspace with the escalation-note marker in their messages.
  // ticket_messages.workspace_id isn't reliably populated on every historical row, so we join by
  // ticket_id + filter tickets to the workspace at step 2 (the tenant boundary).
  const { data: msgs, error: me } = await admin
    .from("ticket_messages")
    .select("ticket_id")
    .ilike("body", `%${ESCALATION_NOTE_MARKER}%`)
    .limit(10_000);
  if (me) throw new Error(`closedWhileEscalated: ticket_messages read failed: ${me.message}`);
  const ticketIds = Array.from(new Set(((msgs as { ticket_id: string }[]) || []).map((r) => r.ticket_id).filter(Boolean)));
  if (!ticketIds.length) return { count: 0, sample: [] };

  // Step 2: of those, count tickets that are closed AND have escalated_to cleared, scoped to the
  // caller's workspace. .in() bounds the fan-out; the workspace_id .eq() is the tenant guard.
  let countQuery = admin
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "closed")
    .is("escalated_to", null)
    .in("id", ticketIds);
  if (sinceIso) countQuery = countQuery.gte("closed_at", sinceIso);
  const { count, error: ce } = await countQuery;
  if (ce) throw new Error(`closedWhileEscalated: tickets count failed: ${ce.message}`);
  const total = count ?? 0;

  // Step 3: pull a small sample for human context (id + closed_at + escalation_reason). Ordered
  // by closed_at DESC so the most recent regressions surface first.
  let sample: ClosedWhileEscalatedRow[] = [];
  if (total > 0 && sampleLimit > 0) {
    let sampleQuery = admin
      .from("tickets")
      .select("id, closed_at, escalation_reason")
      .eq("workspace_id", workspaceId)
      .eq("status", "closed")
      .is("escalated_to", null)
      .in("id", ticketIds);
    if (sinceIso) sampleQuery = sampleQuery.gte("closed_at", sinceIso);
    const { data, error: se } = await sampleQuery.order("closed_at", { ascending: false }).limit(sampleLimit);
    if (se) throw new Error(`closedWhileEscalated: tickets sample failed: ${se.message}`);
    sample = ((data as { id: string; closed_at: string | null; escalation_reason: string | null }[]) || []).map((r) => ({
      ticket_id: r.id,
      closed_at: r.closed_at,
      escalation_reason: r.escalation_reason,
    }));
  }

  return { count: total, sample };
}
