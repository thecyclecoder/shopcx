import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { executeWorkflow } from "@/lib/workflow-executor";

// POST: Manually run a workflow on a ticket
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = await request.json();
  const { workflow_id } = body;
  if (!workflow_id) return NextResponse.json({ error: "workflow_id required" }, { status: 400 });

  const admin = createAdminClient();

  // Verify ticket exists in workspace
  const { data: ticket } = await admin.from("tickets").select("id, tags")
    .eq("id", ticketId).eq("workspace_id", workspaceId).single();
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Get the workflow
  const { data: workflow } = await admin.from("workflows").select("*")
    .eq("id", workflow_id).eq("workspace_id", workspaceId).single();
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (!workflow.enabled) return NextResponse.json({ error: "Workflow is disabled" }, { status: 400 });

  // Add the trigger tag if not already present
  const tags = [...((ticket.tags as string[]) || [])];
  if (!tags.includes(workflow.trigger_tag)) {
    tags.push(workflow.trigger_tag);
    await admin.from("tickets").update({ tags: [...new Set(tags)] }).eq("id", ticketId);
  }

  // Execute the workflow
  await executeWorkflow(workspaceId, ticketId, workflow.trigger_tag);

  return NextResponse.json({ executed: true, workflow: workflow.name });
}
