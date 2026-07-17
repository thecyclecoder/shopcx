/**
 * POST /api/todos/[id]/reject
 *
 * Rejects a single agent_todo. Same role gate as approve. The ticket is NOT
 * auto-closed — it stays escalated so it can be picked up manually. When ALL
 * todos in the group are rejected, the source ticket is escalated to the
 * workspace OWNER (always the owner, never the rejecter — Dylan handles all
 * manual ticket work) and tagged `todo:rejected`.
 *
 * See docs/brain/specs/agent-todo-system.md § Phase 4.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canApprove } from "@/lib/agent-todos/constants";
import type { WorkspaceRole } from "@/lib/types/workspace";
import type { AgentTodo } from "@/lib/agent-todos/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  let reason: string | null = null;
  try {
    const body = await request.json();
    reason = typeof body?.reason === "string" ? body.reason.slice(0, 1000) : null;
  } catch {
    // no body — reason stays null
  }

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

  const t = todo as AgentTodo;
  if (t.status !== "pending") {
    return NextResponse.json({ error: `Todo is ${t.status}, cannot reject` }, { status: 409 });
  }
  if (!canApprove(role, t.action_type)) {
    return NextResponse.json(
      { error: `Your role (${role}) cannot reject ${t.action_type}` },
      { status: 403 },
    );
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await admin
    .from("agent_todos")
    .update({
      status: "rejected",
      rejected_by: user.id,
      rejected_at: now,
      reject_reason: reason,
      updated_at: now,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If the whole group is now rejected, route the ticket to the workspace owner
  // for manual handling (always owner, regardless of who rejected).
  if (t.source_ticket_id) {
    const { data: groupTodos } = await admin
      .from("agent_todos")
      .select("status")
      .eq("group_id", t.group_id);
    const allRejected = (groupTodos || []).length > 0 && (groupTodos || []).every((g) => g.status === "rejected");

    if (allRejected) {
      const { data: owner } = await admin
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .eq("role", "owner")
        .limit(1)
        .maybeSingle();

      await admin
        .from("tickets")
        .update({ escalated_to: owner?.user_id ?? null, updated_at: now })
        .eq("id", t.source_ticket_id);

      const { addTicketTag } = await import("@/lib/ticket-tags");
      await addTicketTag(t.source_ticket_id, "todo:rejected");
    }
  }

  return NextResponse.json(updated);
}
