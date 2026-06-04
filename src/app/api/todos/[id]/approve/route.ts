/**
 * POST /api/todos/[id]/approve
 *
 * Approves a single agent_todo. Role-gated by action_type (see canApprove).
 * Customer-facing actions fire the Inngest event worker for immediate
 * execution; system-level actions wake the Claude Code Routine on-demand
 * (or wait for the next hourly tick if the trigger URL isn't configured).
 *
 * See docs/brain/specs/agent-todo-system.md § Phase 4.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { canApprove, isCustomerFacing } from "@/lib/agent-todos/constants";
import type { WorkspaceRole } from "@/lib/types/workspace";
import type { AgentTodo } from "@/lib/agent-todos/types";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  if (isCustomerFacing(t.action_type)) {
    // Immediate execution — drift check runs inside the worker.
    await inngest.send({ name: "agent-todo/execute", data: { todo_id: id } });
  } else {
    // System-level — wake the Routine on-demand if a trigger URL is configured;
    // otherwise it's picked up on the next hourly tick. Best-effort.
    const triggerUrl = process.env.AGENT_TODO_ROUTINE_TRIGGER_URL;
    if (triggerUrl) {
      try {
        await fetch(triggerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.AGENT_TODO_ROUTINE_TRIGGER_TOKEN
              ? { Authorization: `Bearer ${process.env.AGENT_TODO_ROUTINE_TRIGGER_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({ todo_id: id }),
        });
      } catch (err) {
        // Non-fatal: the hourly tick will still pick it up.
        console.warn("[todos/approve] routine wake failed:", err);
      }
    }
  }

  return NextResponse.json(updated);
}
