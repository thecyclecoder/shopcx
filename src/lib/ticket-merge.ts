/**
 * Ticket merge — single function used by bulk action (agent UI) and Sonnet (auto-merge).
 * Always merges old tickets INTO the newest ticket.
 *
 * Option B semantics (2026-06-05): the target is the single home for the
 * conversation. Messages MOVE (not copy) from source to target. FK references
 * (returns, agent_todos, ticket_analyses, etc.) repoint to the target.
 * Escalation flags carry forward to the target so the work stays visible.
 * The source row remains as an archived stub keyed by `merged_into` — kept
 * so that inbound email threads on the source's original `email_message_id`
 * still resolve, and the audit link is preserved.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface MergeResult {
  success: boolean;
  targetTicketId: string;
  mergedCount: number;
  messagesMoved: number;
  error?: string;
}

/**
 * Tables whose `ticket_id` (or `source_ticket_id`) FK should follow the
 * conversation when it's merged into a new target. Each entry is
 * `[tableName, columnName]`. Keep this list explicit — schema introspection
 * would pick up some columns we don't actually want to repoint (e.g.
 * `derived_from_ticket_id` on ticket_analyses / sonnet_prompts, which is a
 * historical-provenance link, not a "belongs to" link).
 */
const TICKET_FK_TABLES: Array<[string, string]> = [
  ["returns", "ticket_id"],
  ["agent_todos", "source_ticket_id"],
  ["ticket_analyses", "ticket_id"],
  ["ticket_csat", "ticket_id"],
  ["store_credit_log", "ticket_id"],
  ["replacements", "ticket_id"],
  ["appstle_api_calls", "ticket_id"],
  ["journey_sessions", "ticket_id"],
  ["email_log", "ticket_id"],
  ["pattern_feedback", "ticket_id"],
  ["chargeback_subscription_actions", "ticket_id"],
  ["chargeback_monitor", "ticket_id"],
  ["macro_usage_log", "ticket_id"],
  ["ai_token_usage", "ticket_id"],
  ["crisis_customer_actions", "ticket_id"],
];

/**
 * Repoint all known ticket-FK rows from source to target. Used by both new
 * merges and the backfill. Best-effort: an unknown / missing table is
 * tolerated (logged + skipped) so adding new ticket-referencing tables in
 * the future doesn't require this list to be exhaustive on day one.
 */
export async function repointTicketRefs(
  admin: Admin, sourceId: string, targetId: string,
): Promise<{ table: string; updated: number; error?: string }[]> {
  const results: { table: string; updated: number; error?: string }[] = [];
  for (const [table, col] of TICKET_FK_TABLES) {
    try {
      const { error, count } = await admin
        .from(table)
        .update({ [col]: targetId }, { count: "exact" })
        .eq(col, sourceId);
      if (error) {
        // Missing tables come back as PGRST205 (or table-not-found) — fine.
        if ((error.code || "").startsWith("PGRST") || /does not exist/i.test(error.message)) {
          continue;
        }
        results.push({ table, updated: 0, error: error.message });
        continue;
      }
      if ((count || 0) > 0) results.push({ table, updated: count || 0 });
    } catch (err) {
      results.push({ table, updated: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/**
 * Follow a chain of `merged_into` references to the terminal target.
 * Returns the input id if it has no merged_into (already terminal).
 * Caps at 10 hops as a paranoia guard against cycles.
 */
export async function resolveMergedTarget(
  admin: Admin, ticketId: string,
): Promise<string> {
  let current = ticketId;
  for (let i = 0; i < 10; i++) {
    const { data } = await admin
      .from("tickets")
      .select("merged_into")
      .eq("id", current)
      .maybeSingle();
    if (!data?.merged_into || data.merged_into === current) return current;
    current = data.merged_into as string;
  }
  return current;
}

/**
 * Merge multiple tickets into the newest one.
 * @param workspaceId - workspace scope
 * @param ticketIds - 2+ ticket IDs to merge
 * @param mergedBy - display name of who triggered the merge (agent name or "AI Agent")
 */
export async function mergeTickets(
  workspaceId: string,
  ticketIds: string[],
  mergedBy: string = "System",
): Promise<MergeResult> {
  if (ticketIds.length < 2) {
    return { success: false, targetTicketId: "", mergedCount: 0, messagesMoved: 0, error: "Need at least 2 tickets" };
  }

  const admin = createAdminClient();

  // Fetch all tickets — order by where the customer is actively engaged.
  // last_customer_reply_at is the signal we want: for chat especially, we
  // can't merge replies into a stale session the customer no longer has
  // open, so target = the ticket where the customer most recently spoke.
  // Tie-break by created_at desc so we still prefer the newer ticket when
  // last_customer_reply_at is null/equal.
  const { data: rawTickets } = await admin.from("tickets")
    .select("id, customer_id, status, subject, tags, created_at, active_playbook_id, playbook_step, playbook_context, playbook_queue, playbook_exceptions_used, journey_id, journey_step, journey_data, merged_into, agent_intervened, assigned_to, do_not_reply, do_not_reply_at, escalated_at, escalated_to, escalation_reason, last_customer_reply_at, channel")
    .eq("workspace_id", workspaceId)
    .in("id", ticketIds);
  const allTickets = (rawTickets || []).slice().sort((a, b) => {
    // Prefer a LIVE ticket as the merge target — we never want to move an
    // active ticket's messages into an archived stub and lose them from the
    // queue. Archived tickets are still valid *sources* (we routinely need a
    // prior, archived thread's context pulled into the current ticket).
    const aArch = a.status === "archived" ? 1 : 0;
    const bArch = b.status === "archived" ? 1 : 0;
    if (aArch !== bArch) return aArch - bArch;
    const aReply = a.last_customer_reply_at ? new Date(a.last_customer_reply_at as string).getTime() : 0;
    const bReply = b.last_customer_reply_at ? new Date(b.last_customer_reply_at as string).getTime() : 0;
    if (bReply !== aReply) return bReply - aReply;
    return new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime();
  });

  if (!allTickets || allTickets.length < 2) {
    return { success: false, targetTicketId: "", mergedCount: 0, messagesMoved: 0, error: "Need at least 2 valid tickets" };
  }

  // Archived tickets ARE mergeable — an archived prior thread is often exactly
  // the context we need to bring into the live ticket. The sort above keeps a
  // live ticket as the target; archived rows merge in as sources.

  // Reject already-merged tickets
  const alreadyMerged = allTickets.filter(t => t.merged_into);
  if (alreadyMerged.length > 0) {
    return { success: false, targetTicketId: "", mergedCount: 0, messagesMoved: 0, error: "Cannot merge tickets that were already merged" };
  }

  // Customer guard — verify all belong to same customer or linked accounts
  const customerIds = [...new Set(allTickets.map(t => t.customer_id).filter(Boolean))];
  if (customerIds.length > 1) {
    const linked = await areCustomersLinked(admin, customerIds);
    if (!linked) {
      return { success: false, targetTicketId: "", mergedCount: 0, messagesMoved: 0, error: "Tickets belong to different unlinked customers" };
    }
  }

  // Target = newest ticket (first in desc order)
  const target = allTickets[0];
  const sources = allTickets.slice(1);

  let totalMoved = 0;
  const nowIso = () => new Date().toISOString();

  for (const source of sources) {
    // MOVE messages from source to target. Reassign ticket_id rather than
    // copy-and-delete so we keep email_message_id linkage intact and don't
    // need to manage two rows for the same message.
    const { count: movedCount } = await admin
      .from("ticket_messages")
      .update({ ticket_id: target.id }, { count: "exact" })
      .eq("ticket_id", source.id);
    totalMoved += movedCount || 0;

    // Carry forward tags (deduplicate)
    const sourceTags = Array.isArray(source.tags) ? source.tags as string[] : [];
    if (sourceTags.length > 0) {
      const targetTags = Array.isArray(target.tags) ? target.tags as string[] : [];
      const merged = [...new Set([...targetTags, ...sourceTags])];
      await admin.from("tickets").update({ tags: merged }).eq("id", target.id);
      target.tags = merged;
    }

    // Carry forward playbook/journey state if target doesn't have one
    if (!target.active_playbook_id && source.active_playbook_id) {
      await admin.from("tickets").update({
        active_playbook_id: source.active_playbook_id,
        playbook_step: source.playbook_step,
        playbook_context: source.playbook_context,
        playbook_queue: source.playbook_queue,
        playbook_exceptions_used: source.playbook_exceptions_used,
      }).eq("id", target.id);
    }
    if (!target.journey_id && source.journey_id) {
      await admin.from("tickets").update({
        journey_id: source.journey_id,
        journey_step: source.journey_step,
        journey_data: source.journey_data,
      }).eq("id", target.id);
    }

    // Carry forward agent intervention + do_not_reply (see prior comments)
    const t = target as { agent_intervened?: boolean; assigned_to?: string | null; do_not_reply?: boolean; do_not_reply_at?: string | null };
    const s = source as { agent_intervened?: boolean; assigned_to?: string | null; do_not_reply?: boolean; do_not_reply_at?: string | null };
    const updates: Record<string, unknown> = {};
    if (!t.agent_intervened && s.agent_intervened) {
      updates.agent_intervened = true; t.agent_intervened = true;
    }
    // Only carry forward an assignment when a HUMAN actually worked the source
    // (agent_intervened). A bare routine/auto-assignment (e.g. assigned to the
    // agent-todo routine with agent_intervened=false) must NOT propagate — it
    // flips the merged ticket into "agent-handled / defer" mode and blocks the
    // standard playbooks (cancel/refund) even though no human is on it. (Ida
    // McDonald 2026-06-10: a merged routine-assignment killed her refund flow.)
    if (!t.assigned_to && s.assigned_to && s.agent_intervened) {
      updates.assigned_to = s.assigned_to; t.assigned_to = s.assigned_to;
    }
    if (!t.do_not_reply && s.do_not_reply) {
      updates.do_not_reply = true;
      updates.do_not_reply_at = s.do_not_reply_at || nowIso();
      t.do_not_reply = true;
    }
    // ai_disabled is DELIBERATELY NOT propagated. It is a per-ticket
    // human directive against a specific conversation; folding it onto
    // the surviving ticket would silently disable the AI on unrelated
    // customer threads the target already carries. The surviving ticket
    // keeps its own value (default false). Phase 1 of
    // docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md —
    // "a merge conveys context, never control."

    // CARRY ESCALATION FORWARD. If the source was escalated and the target
    // isn't, the target inherits the escalation — otherwise the work
    // disappears once we archive the source. If both are escalated, target's
    // existing escalation wins (it's the more recent one).
    const te = target as { escalated_to?: string | null; escalated_at?: string | null; escalation_reason?: string | null };
    const se = source as { escalated_to?: string | null; escalated_at?: string | null; escalation_reason?: string | null };
    if (!te.escalated_at && (se.escalated_at || se.escalated_to)) {
      updates.escalated_to = se.escalated_to ?? null;
      updates.escalated_at = se.escalated_at ?? nowIso();
      updates.escalation_reason = se.escalation_reason ?? null;
      te.escalated_at = se.escalated_at ?? nowIso();
      te.escalated_to = se.escalated_to ?? null;
    }
    if (Object.keys(updates).length > 0) {
      await admin.from("tickets").update(updates).eq("id", target.id);
    }

    // Repoint FK refs (returns, agent_todos, ticket_analyses, etc.)
    await repointTicketRefs(admin, source.id, target.id);

    // System note on target — clickable UUID handled by the renderer
    await admin.from("ticket_messages").insert({
      ticket_id: target.id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] ${mergedBy} merged ticket "${source.subject || source.id.substring(0, 8)}" (${source.id}) into this ticket (${movedCount || 0} messages).`,
    });

    // Archive source with merged_into reference. The source is a stub —
    // messages have moved, FKs have moved, escalation has moved. It exists
    // only to keep email_message_id thread resolution working and to
    // preserve the audit link.
    await admin.from("tickets").update({
      status: "archived",
      archived_at: nowIso(),
      merged_into: target.id,
      // Clear escalation on source — it now lives on the target.
      escalated_to: null,
      escalated_at: null,
      escalation_reason: null,
      updated_at: nowIso(),
    }).eq("id", source.id);
  }

  // Reopen target if it was closed — unless it inherited do_not_reply
  // through this merge (or already had it). A deactivated ticket should
  // stay closed; reopening would invite the handler to engage again.
  const targetFinal = target as { status?: string; do_not_reply?: boolean };
  if (targetFinal.status === "closed" && !targetFinal.do_not_reply) {
    await admin.from("tickets").update({
      status: "open",
      updated_at: nowIso(),
    }).eq("id", target.id);
  }

  return {
    success: true,
    targetTicketId: target.id,
    mergedCount: sources.length,
    messagesMoved: totalMoved,
  };
}

/**
 * Check if all customer IDs belong to the same linked group.
 */
async function areCustomersLinked(
  admin: Admin,
  customerIds: string[],
): Promise<boolean> {
  if (customerIds.length <= 1) return true;

  const { data: links } = await admin.from("customer_links")
    .select("customer_id, group_id")
    .in("customer_id", customerIds);

  if (!links || links.length === 0) return false;

  const groupIds = new Set(links.map(l => l.group_id));
  for (const gid of groupIds) {
    const inGroup = links.filter(l => l.group_id === gid).map(l => l.customer_id);
    if (customerIds.every(cid => inGroup.includes(cid))) return true;
  }

  return false;
}
