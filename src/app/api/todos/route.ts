/**
 * GET /api/todos — list view for /dashboard/tickets/todos.
 *
 * Query params:
 *   status      — default 'pending' (or 'all')
 *   urgency     — 'urgent' | 'normal' | 'low'
 *   action_type — one of the action_type enum values
 *   source      — 'ticket' | 'csat' | 'cron' | 'manual'
 *   mine        — 'true' → only todos the caller's role can approve
 *   limit/offset
 *
 * Returns { todos, total, approvable_count }. `approvable_count` is the
 * role-scoped bubble count (pending todos the caller can approve).
 *
 * See docs/brain/dashboard/tickets__todos.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canApprove } from "@/lib/agent-todos/constants";
import type { WorkspaceRole } from "@/lib/types/workspace";
import { ALL_ACTION_TYPES, type AgentTodoActionType } from "@/lib/agent-todos/constants";

export async function GET(request: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const role = member.role as WorkspaceRole;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "pending";
  const urgency = url.searchParams.get("urgency");
  const actionType = url.searchParams.get("action_type");
  const source = url.searchParams.get("source");
  const mine = url.searchParams.get("mine") === "true";
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
  const offset = Number(url.searchParams.get("offset") || 0);

  let query = admin
    .from("agent_todos")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status !== "all") query = query.eq("status", status);
  if (urgency) query = query.eq("urgency", urgency);
  if (actionType) query = query.eq("action_type", actionType);
  if (source) query = query.eq("source", source);

  const { data: todos, count } = await query;

  // Role-scoped "items I can approve" filter.
  const approvableTypes = ALL_ACTION_TYPES.filter((t) => canApprove(role, t));
  let rows = todos || [];
  if (mine) rows = rows.filter((t) => approvableTypes.includes(t.action_type as AgentTodoActionType));

  // Enrich with customer name + ticket subject (batch fetch).
  const ticketIds = [...new Set(rows.map((t) => t.source_ticket_id).filter(Boolean))] as string[];
  const ticketMap = new Map<string, { subject: string | null; customer_id: string | null }>();
  const custMap = new Map<string, { first_name: string | null; last_name: string | null; email: string | null }>();
  if (ticketIds.length) {
    const { data: tix } = await admin
      .from("tickets")
      .select("id, subject, customer_id")
      .in("id", ticketIds);
    for (const tk of tix || []) ticketMap.set(tk.id, { subject: tk.subject, customer_id: tk.customer_id });
    const custIds = [...new Set((tix || []).map((t) => t.customer_id).filter(Boolean))] as string[];
    if (custIds.length) {
      const { data: custs } = await admin
        .from("customers")
        .select("id, first_name, last_name, email")
        .in("id", custIds);
      for (const c of custs || []) custMap.set(c.id, { first_name: c.first_name, last_name: c.last_name, email: c.email });
    }
  }

  const enriched = rows.map((t) => {
    const tk = t.source_ticket_id ? ticketMap.get(t.source_ticket_id) : undefined;
    const cust = tk?.customer_id ? custMap.get(tk.customer_id) : undefined;
    const customerName = cust
      ? `${cust.first_name || ""} ${cust.last_name || ""}`.trim() || cust.email || "Customer"
      : "—";
    return {
      ...t,
      ticket_subject: tk?.subject || null,
      customer_name: customerName,
      can_approve: approvableTypes.includes(t.action_type as AgentTodoActionType),
    };
  });

  // Bubble count: pending todos this role can approve.
  const { data: pendingForCount } = await admin
    .from("agent_todos")
    .select("action_type")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending");
  const approvableCount = (pendingForCount || []).filter((t) =>
    approvableTypes.includes(t.action_type as AgentTodoActionType),
  ).length;

  return NextResponse.json({
    todos: enriched,
    total: count || 0,
    approvable_count: approvableCount,
    role,
  });
}
