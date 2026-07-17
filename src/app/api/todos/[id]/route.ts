/**
 * GET /api/todos/[id] — detail view for /dashboard/tickets/todos/[id].
 *
 * Returns the todo, its full group (todos sharing group_id), the source ticket
 * + customer header (name, LTV, subject, escalation reason), and the ticket
 * conversation (collapsed appendix). Also returns the caller's role so the UI
 * can gate approve/reject buttons per todo.
 *
 * See docs/brain/dashboard/tickets__todos__id.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canApprove } from "@/lib/agent-todos/constants";
import type { WorkspaceRole } from "@/lib/types/workspace";
import { ALL_ACTION_TYPES, type AgentTodoActionType } from "@/lib/agent-todos/constants";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

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

  const { data: todo } = await admin
    .from("agent_todos")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .single();
  if (!todo) return NextResponse.json({ error: "Todo not found" }, { status: 404 });

  // The full group, ordered so customer_reply leads.
  const { data: group } = await admin
    .from("agent_todos")
    .select("*")
    .eq("group_id", todo.group_id)
    .order("created_at", { ascending: true });

  const approvableTypes = ALL_ACTION_TYPES.filter((t) => canApprove(role, t));
  const groupWithGate = (group || []).map((g) => ({
    ...g,
    can_approve: approvableTypes.includes(g.action_type as AgentTodoActionType),
  }));

  // Resolve approver display names for any non-pending todo in the group.
  const approverIds = [
    ...new Set([
      ...(group || []).map((g) => g.approved_by).filter(Boolean),
      ...(group || []).map((g) => g.rejected_by).filter(Boolean),
    ]),
  ] as string[];
  const nameMap = new Map<string, string>();
  if (approverIds.length) {
    const { data: members } = await admin
      .from("workspace_members")
      .select("user_id, display_name")
      .in("user_id", approverIds);
    for (const m of members || []) nameMap.set(m.user_id, m.display_name || "");
  }

  // Source ticket + customer header.
  let ticket: Record<string, unknown> | null = null;
  let customer: Record<string, unknown> | null = null;
  let ltvCents = 0;
  let messages: unknown[] = [];
  if (todo.source_ticket_id) {
    const { data: tk } = await admin
      .from("tickets")
      .select("id, subject, status, channel, escalation_reason, escalated_at, customer_id")
      .eq("id", todo.source_ticket_id)
      .single();
    ticket = tk;
    if (tk?.customer_id) {
      const { data: c } = await admin
        .from("customers")
        .select("id, first_name, last_name, email")
        .eq("id", tk.customer_id)
        .single();
      customer = c;
      const { data: orders } = await admin
        .from("orders")
        .select("total_cents")
        .eq("workspace_id", workspaceId)
        .eq("customer_id", tk.customer_id);
      ltvCents = (orders || []).reduce((sum, o) => sum + (o.total_cents || 0), 0);
    }
    const { data: msgs } = await admin
      .from("ticket_messages")
      .select("id, direction, visibility, author_type, body, created_at")
      .eq("ticket_id", todo.source_ticket_id)
      .order("created_at", { ascending: true });
    messages = msgs || [];
  }

  return NextResponse.json({
    todo,
    group: groupWithGate,
    approver_names: Object.fromEntries(nameMap),
    ticket,
    customer,
    ltv_cents: ltvCents,
    messages,
    role,
  });
}
