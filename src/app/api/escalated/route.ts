/**
 * GET /api/escalated — observability surface for the whole escalation pipeline.
 *
 * Replaces the old `escalated_to = me` filter. Returns EVERY ticket where
 * escalated_at IS NOT NULL, sorted by escalated_at desc, each tagged with a
 * "routed_to" status derived from its agent_todos group + escalated_to. Also
 * returns chip counts for the filter bar and the "Rejected → me" bubble count.
 *
 * See docs/brain/dashboard/tickets__escalated.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type RoutedTo =
  | "routine" // escalated, no todo group yet
  | "todo_pending"
  | "todo_approved"
  | "rejected" // at least one rejected todo; escalated_to set
  | "assigned"; // legacy human assignment, no todos

export async function GET(request: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, status, channel, escalation_reason, escalated_at, escalated_to, assigned_to, customer_id")
    .eq("workspace_id", workspaceId)
    .not("escalated_at", "is", null)
    // Belt-and-suspenders: escalation is an open-state concept, so a stale flag on
    // a resolved ticket must never surface here. Close/resolve now clears the flags
    // at the write paths; this guarantees the read side even if one ever lingers.
    .not("status", "in", "(closed,resolved,archived)")
    .order("escalated_at", { ascending: false })
    .limit(500);

  const ticketRows = tickets || [];
  const ticketIds = ticketRows.map((t) => t.id);

  // All todos for these tickets, grouped by ticket.
  const todosByTicket = new Map<string, Array<{ status: string }>>();
  if (ticketIds.length) {
    const { data: todos } = await admin
      .from("agent_todos")
      .select("source_ticket_id, status")
      .in("source_ticket_id", ticketIds);
    for (const td of todos || []) {
      if (!td.source_ticket_id) continue;
      const arr = todosByTicket.get(td.source_ticket_id) || [];
      arr.push({ status: td.status });
      todosByTicket.set(td.source_ticket_id, arr);
    }
  }

  // Resolve names for escalated_to / assigned_to.
  const userIds = [
    ...new Set([
      ...ticketRows.map((t) => t.escalated_to).filter(Boolean),
      ...ticketRows.map((t) => t.assigned_to).filter(Boolean),
    ]),
  ] as string[];
  const nameMap = new Map<string, string>();
  if (userIds.length) {
    const { data: members } = await admin
      .from("workspace_members")
      .select("user_id, display_name")
      .in("user_id", userIds);
    for (const m of members || []) nameMap.set(m.user_id, m.display_name || "");
  }

  // Customer names.
  const custIds = [...new Set(ticketRows.map((t) => t.customer_id).filter(Boolean))] as string[];
  const custMap = new Map<string, string>();
  if (custIds.length) {
    const { data: custs } = await admin
      .from("customers")
      .select("id, first_name, last_name, email")
      .in("id", custIds);
    for (const c of custs || [])
      custMap.set(c.id, `${c.first_name || ""} ${c.last_name || ""}`.trim() || c.email || "Customer");
  }

  function routedTo(t: (typeof ticketRows)[number]): RoutedTo {
    const todos = todosByTicket.get(t.id) || [];
    const active = todos.filter((td) => td.status === "pending" || td.status === "approved");
    const hasRejected = todos.some((td) => td.status === "rejected");
    if (todos.length === 0) {
      return t.assigned_to || t.escalated_to ? "assigned" : "routine";
    }
    if (active.some((td) => td.status === "pending")) return "todo_pending";
    if (active.length && active.every((td) => td.status === "approved")) return "todo_approved";
    if (hasRejected) return "rejected";
    return "routine";
  }

  const enriched = ticketRows.map((t) => {
    const routed = routedTo(t);
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      channel: t.channel,
      escalation_reason: t.escalation_reason,
      escalated_at: t.escalated_at,
      customer_name: t.customer_id ? custMap.get(t.customer_id) || "—" : "—",
      routed_to: routed,
      routed_name: routed === "rejected" ? nameMap.get(t.escalated_to || "") || "" : routed === "assigned" ? nameMap.get((t.assigned_to || t.escalated_to) || "") || "" : "",
      escalated_to: t.escalated_to,
    };
  });

  // Chip counts.
  const chips = {
    all: enriched.length,
    routine_pending: enriched.filter((t) => t.routed_to === "routine").length,
    awaiting_approval: enriched.filter((t) => t.routed_to === "todo_pending").length,
    approved_pending_execute: enriched.filter((t) => t.routed_to === "todo_approved").length,
    rejected_me: enriched.filter((t) => t.routed_to === "rejected" && t.escalated_to === user.id).length,
    assigned_human_legacy: enriched.filter((t) => t.routed_to === "assigned").length,
  };

  return NextResponse.json({ tickets: enriched, chips, current_user_id: user.id });
}
