import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { generateAIDraft } from "@/lib/ai-draft";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Verify ticket belongs to workspace
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, workspace_id")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  try {
    const result = await generateAIDraft(workspaceId, ticketId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("AI draft error:", err);
    return NextResponse.json(
      { error: `Draft failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

// GET: retrieve existing draft for a ticket
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("ai_draft, ai_confidence, ai_tier, ai_source_type, ai_source_id, ai_workflow_id, ai_drafted_at, ai_suggested_macro_id, ai_suggested_macro_name")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Get source info
  let sourceName: string | null = null;
  if (ticket.ai_source_type === "macro" && ticket.ai_source_id) {
    const { data: macro } = await admin.from("macros").select("name").eq("id", ticket.ai_source_id).single();
    sourceName = macro?.name || null;
  } else if (ticket.ai_source_type === "kb" && ticket.ai_source_id) {
    const { data: kb } = await admin.from("knowledge_base").select("title").eq("id", ticket.ai_source_id).single();
    sourceName = kb?.title || null;
  }

  return NextResponse.json({
    ...ticket,
    source_name: sourceName,
  });
}
