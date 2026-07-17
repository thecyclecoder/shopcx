/**
 * POST /api/todos/[id]/approve
 *
 * Approves a single agent_todo. Role-gated by action_type (see canApprove). Every surviving action
 * type (customer_reply/customer_action/ticket_close/ticket_analysis_rescore) is executed by the
 * Inngest event worker within seconds — the Anthropic-cloud routine that once ran system-level todos
 * is retired (box-escalation-triage); rule/code proposals are now sonnet_prompts / spec files.
 *
 * See docs/brain/lifecycles/agent-todo-system.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { canApprove, isInngestExecutable } from "@/lib/agent-todos/constants";
import type { WorkspaceRole } from "@/lib/types/workspace";
import type { AgentTodo } from "@/lib/agent-todos/types";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const t = todo as AgentTodo;
  if (t.status !== "pending") {
    return NextResponse.json({ error: `Todo is ${t.status}, cannot approve` }, { status: 409 });
  }
  if (!canApprove(role, t.action_type)) {
    return NextResponse.json(
      { error: `Your role (${role}) cannot approve ${t.action_type}` },
      { status: 403 },
    );
  }

  const approvalRole = role === "owner" ? "owner" : "admin";
  const now = new Date().toISOString();
  const { data: updated, error } = await admin
    .from("agent_todos")
    .update({
      status: "approved",
      approved_by: user.id,
      approved_at: now,
      approval_role: approvalRole,
      updated_at: now,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (isInngestExecutable(t.action_type)) {
    // Immediate execution — drift check runs inside the worker. Covers all surviving action types
    // (customer reply/action/close + ticket_analysis_rescore) now that the routine is retired.
    await inngest.send({ name: "agent-todo/execute", data: { todo_id: id } });
  }

  return NextResponse.json(updated);
}
