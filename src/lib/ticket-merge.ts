/**
 * Ticket merge — single function used by bulk action (agent UI) and Sonnet (auto-merge).
 * Always merges old tickets INTO the newest ticket.
 * Old tickets are archived with `merged_into` reference.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface MergeResult {
  success: boolean;
  targetTicketId: string;
  mergedCount: number;
  messagesMoved: number;
  error?: string;
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

  // Fetch all tickets
  const { data: allTickets } = await admin.from("tickets")
    .select("id, customer_id, status, subject, tags, created_at, active_playbook_id, playbook_step, playbook_context, playbook_queue, playbook_exceptions_used, journey_id, journey_step, journey_data, merged_into")
    .eq("workspace_id", workspaceId)
    .in("id", ticketIds)
    .order("created_at", { ascending: false }); // Newest first

  if (!allTickets || allTickets.length < 2) {
    return { success: false, targetTicketId: "", mergedCount: 0, messagesMoved: 0, error: "Need at least 2 valid tickets" };
  }

  // Reject archived tickets
  const archived = allTickets.filter(t => t.status === "archived");
  if (archived.length > 0) {
    return { success: false, targetTicketId: "", mergedCount: 0, messagesMoved: 0, error: `Cannot merge archived tickets: ${archived.map(t => t.id.substring(0, 8)).join(", ")}` };
  }

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

  for (const source of sources) {
    // Copy messages from source to target (keep originals on source for reference)
    const { data: messages } = await admin.from("ticket_messages")
      .select("direction, visibility, author_type, author_id, body, email_message_id, ai_draft, created_at, macro_id, ai_personalized, meta_message_id, body_clean, pending_send_at, sent_at, send_cancelled, resend_email_id, email_status")
      .eq("ticket_id", source.id)
      .order("created_at", { ascending: true });

    if (messages?.length) {
      const copies = messages.map(m => ({ ...m, ticket_id: target.id }));
      await admin.from("ticket_messages").insert(copies);
      totalMoved += messages.length;
    }

    // Carry forward tags (deduplicate)
    const sourceTags = Array.isArray(source.tags) ? source.tags as string[] : [];
    if (sourceTags.length > 0) {
      const targetTags = Array.isArray(target.tags) ? target.tags as string[] : [];
      const merged = [...new Set([...targetTags, ...sourceTags])];
      await admin.from("tickets").update({ tags: merged }).eq("id", target.id);
      target.tags = merged; // Update in-memory for subsequent iterations
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

    // Add system note on target
    await admin.from("ticket_messages").insert({
      ticket_id: target.id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] ${mergedBy} merged ticket "${source.subject || source.id.substring(0, 8)}" into this ticket (${messages?.length || 0} messages).`,
    });

    // Add system note on source (for reference when viewing archived ticket)
    await admin.from("ticket_messages").insert({
      ticket_id: source.id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] This ticket was merged into ticket ${target.id}.`,
    });

    // Archive source with merged_into reference
    await admin.from("tickets").update({
      status: "archived",
      archived_at: new Date().toISOString(),
      merged_into: target.id,
      updated_at: new Date().toISOString(),
    }).eq("id", source.id);
  }

  // Reopen target if it was closed
  if (target.status === "closed") {
    await admin.from("tickets").update({
      status: "open",
      updated_at: new Date().toISOString(),
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
  admin: ReturnType<typeof createAdminClient>,
  customerIds: string[],
): Promise<boolean> {
  if (customerIds.length <= 1) return true;

  // Get group_ids for all customers
  const { data: links } = await admin.from("customer_links")
    .select("customer_id, group_id")
    .in("customer_id", customerIds);

  if (!links || links.length === 0) return false;

  // Check if all customers share at least one group
  const groupIds = new Set(links.map(l => l.group_id));
  for (const gid of groupIds) {
    const inGroup = links.filter(l => l.group_id === gid).map(l => l.customer_id);
    if (customerIds.every(cid => inGroup.includes(cid))) return true;
  }

  return false;
}
