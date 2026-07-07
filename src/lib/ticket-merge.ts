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
import { SONNET_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Message shape passed to the merge-summary builder. Only the fields the
 * summarizer reads — kept minimal so the prompt stays token-efficient.
 */
interface MergedMessage {
  direction: string | null;
  author_type: string | null;
  visibility: string | null;
  body: string | null;
  created_at: string | null;
}

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
  // Collect the messages that MOVED in this merge event — the "pre-merge
  // thread" the summarizer distills at the end of the loop. Captured on the
  // source PRIOR to the move so we can identify them again on the target.
  const movedMessageIds: string[] = [];

  for (const source of sources) {
    // Snapshot the source's message ids BEFORE the move — the update below
    // only returns a count, and we need the ids to feed the summarizer
    // exactly the newly-merged content (not the target's pre-existing
    // history) on a repeat-merge.
    const { data: preMove } = await admin
      .from("ticket_messages")
      .select("id")
      .eq("ticket_id", source.id);
    if (preMove) for (const row of preMove) movedMessageIds.push(row.id as string);

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

  // Lock in the pre-merge state as a durable Sonnet summary on the target so
  // downstream Opus turns read the summary instead of re-costing the full
  // merged history on every call (kills the cache-recost loop measured on
  // ticket 49ddd6c4 → $8.92). Fire-and-forget: a summarizer failure must
  // never break the merge itself. See docs/brain/specs/ticket-merge-summary-
  // and-context-cap.md Phase 1.
  try {
    await generateAndPersistMergeSummary(admin, workspaceId, target.id, movedMessageIds);
  } catch (err) {
    console.warn("[ticket-merge] merge-summary generation failed (non-fatal):", err);
  }

  return {
    success: true,
    targetTicketId: target.id,
    mergedCount: sources.length,
    messagesMoved: totalMoved,
  };
}

/**
 * Regenerate the merge summary?
 *
 *   • No prior summary → always summarize (first merge on this target).
 *   • Prior summary exists → summarize only when this merge event actually
 *     moved new content in. A merge that moved zero messages (edge case:
 *     empty source thread) with a prior summary is a no-op — this is the
 *     verification bullet "does not re-summarize unchanged history on a
 *     later unrelated update."
 *
 * Pure predicate — unit-testable with no DB / no network. Kept exported for
 * the Phase-1 test (src/lib/ticket-merge.test.ts).
 */
export function shouldRegenerateMergeSummary(
  priorSummary: string | null,
  newlyMovedCount: number,
): boolean {
  if (!priorSummary) return true;
  return newlyMovedCount > 0;
}

/**
 * Build the Sonnet summarizer prompt. Pure — no I/O — so it can be tested
 * against the Phase-1 verification (compact plain-text state summary, prior
 * summary carried forward on repeat merges). Kept exported for the test.
 *
 * Two shapes:
 *   • First merge — no prior summary → summarize the merged conversation
 *     itself.
 *   • Repeat merge — prior summary present → carry the prior summary
 *     forward as "prior state" + feed only the newly-merged messages,
 *     so we don't re-cost the entire target history to Sonnet on every
 *     merge event.
 */
export function buildMergeSummaryPrompt(
  priorSummary: string | null,
  messages: MergedMessage[],
): { system: string; user: string } {
  const system =
    "You are a support-ticket state summarizer. Distill the STATE of this ticket " +
    "into a compact plain-text summary that downstream AI turns can rely on instead " +
    "of re-reading every message. Include: the customer's core issue; confirmed " +
    "facts (address, order id, product, dates, contact channel); actions already " +
    "taken (refund issued, replacement sent, cancellation processed); and open " +
    "items still to resolve. Be terse: state, not chat. No markdown, no bullet " +
    "characters, no headers — one short paragraph per fact/action/open item. Cover " +
    "all durable state so a fresh reader can pick up cold; skip pleasantries and " +
    "quoted email boilerplate.";

  const conversation = messages
    .map((m) => {
      const who = m.author_type || "unknown";
      const dir = m.direction || "";
      const vis = m.visibility === "internal" ? " (internal)" : "";
      const body = (m.body || "").trim();
      return `[${who}/${dir}${vis}] ${body}`;
    })
    .join("\n\n");

  const user = priorSummary
    ? `PRIOR STATE (carry forward, refine as needed):\n${priorSummary}\n\n` +
      `NEWLY MERGED MESSAGES:\n${conversation}\n\n` +
      `Return the updated compact state summary as plain text.`
    : `MERGED CONVERSATION:\n${conversation}\n\n` +
      `Return the compact state summary as plain text.`;

  return { system, user };
}

/**
 * Generate + persist the one-shot merge summary on the target. Called from
 * mergeTickets() after all messages have been moved. Fire-and-forget on
 * failure (missing API key / Anthropic outage / parse failure) so the merge
 * itself is never blocked — Phase 2's context assembly falls back to the
 * legacy behavior when merge_summary is NULL.
 */
async function generateAndPersistMergeSummary(
  admin: Admin,
  workspaceId: string,
  targetId: string,
  newlyMovedMessageIds: string[],
): Promise<void> {
  if (!ANTHROPIC_API_KEY) return;

  const { data: t } = await admin
    .from("tickets")
    .select("merge_summary")
    .eq("id", targetId)
    .maybeSingle();
  const priorSummary = (t?.merge_summary as string | null) || null;

  if (!shouldRegenerateMergeSummary(priorSummary, newlyMovedMessageIds.length)) return;

  // Which messages feed the summarizer:
  //   first merge (no prior)  → the full target thread (includes moved sources)
  //   repeat merge (prior)    → only the ids that moved in this event
  let msgs: MergedMessage[] = [];
  if (!priorSummary) {
    const { data } = await admin
      .from("ticket_messages")
      .select("direction, author_type, visibility, body, created_at")
      .eq("ticket_id", targetId)
      .order("created_at", { ascending: true })
      .limit(500);
    msgs = (data || []) as MergedMessage[];
  } else if (newlyMovedMessageIds.length > 0) {
    const { data } = await admin
      .from("ticket_messages")
      .select("direction, author_type, visibility, body, created_at")
      .in("id", newlyMovedMessageIds)
      .order("created_at", { ascending: true })
      .limit(500);
    msgs = (data || []) as MergedMessage[];
  }

  if (msgs.length === 0 && !priorSummary) return;

  const { system, user } = buildMergeSummaryPrompt(priorSummary, msgs);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch (err) {
    console.warn("[ticket-merge] merge-summary Sonnet fetch failed:", err);
    return;
  }
  if (!res.ok) {
    console.warn("[ticket-merge] merge-summary Sonnet HTTP", res.status);
    return;
  }

  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: Parameters<typeof logAiUsage>[0]["usage"];
  };
  const summary = (data.content?.[0]?.text || "").trim();
  if (!summary) return;

  // Persist. Guard with .eq("id", targetId) + .select("id") so a stale target
  // id can't accidentally scribble across another workspace's row — same
  // compare-and-set discipline as the rest of the merge writes.
  const { data: written } = await admin
    .from("tickets")
    .update({
      merge_summary: summary,
      merge_summary_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetId)
    .eq("workspace_id", workspaceId)
    .select("id");

  if (!written || written.length !== 1) {
    console.warn("[ticket-merge] merge-summary update matched", written?.length ?? 0, "rows");
    return;
  }

  await logAiUsage({
    workspaceId,
    model: SONNET_MODEL,
    usage: data.usage,
    purpose: "merge_summary",
    ticketId: targetId,
  });
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
