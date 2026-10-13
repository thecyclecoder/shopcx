/**
 * cs-director-close-gate — the pre-close read of inbound customer messages for the
 * `close_no_action` gate in [[../../scripts/builder-worker.ts]] `runCsDirectorCallJob`.
 *
 * The sibling of [[./inflection-detector]] `loadTriggerMessageForTicket` (Phase 5 of
 * [[../../docs/brain/specs/inflection-resession-must-act-on-newest-ask.md]]): `ticket_messages`
 * has NO `workspace_id` column of its own (it hangs off the ticket), so a bare
 * `.eq('ticket_id', …)` service-role read would succeed for a ticket owned by ANY workspace —
 * a foreign ticket_id passed through the agent_jobs instructions could leak messages from a
 * different tenant into the CS Director's close-no-action builder. The fix: a PostgREST
 * `tickets!inner` join with a `tickets.workspace_id` filter — the ticket row must belong to
 * the caller's workspace or the message set is empty. The row shape mirrors the previous
 * inline call site exactly so `decideCsDirectorTicketTransition.inboundMessages` is unchanged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CloseGateInboundMessage {
  id: string;
  direction: string;
  author_type: string;
  visibility: string | null;
  body: string | null;
  body_clean: string | null;
  created_at: string;
}

/**
 * Load the ascending list of inbound customer messages for a ticket, strictly scoped to the
 * caller's workspace via a `tickets!inner` join. A foreign-workspace `ticket_id` resolves to
 * an empty array (NOT a privacy leak dressed up as a null); so does any other error — the
 * caller treats that identically to today's "no inbound messages" close-no-action behavior
 * (fail-safe fallthrough, a DB blip must never force-close over an unresolved customer ask).
 */
export async function loadInboundMessagesForCloseGate(
  admin: SupabaseClient,
  workspace_id: string,
  ticket_id: string,
): Promise<CloseGateInboundMessage[]> {
  const { data, error } = await admin
    .from("ticket_messages")
    .select(
      "id, direction, author_type, visibility, body, body_clean, created_at, tickets!inner(id)",
    )
    .eq("ticket_id", ticket_id)
    .eq("tickets.workspace_id", workspace_id)
    .eq("direction", "inbound")
    .eq("author_type", "customer")
    .order("created_at", { ascending: true });
  if (error) return [];
  const rows = (data as Array<CloseGateInboundMessage> | null) ?? [];
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    author_type: r.author_type,
    visibility: r.visibility,
    body: r.body,
    body_clean: r.body_clean,
    created_at: r.created_at,
  }));
}
