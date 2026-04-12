import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST: Merge multiple tickets into one.
 * Moves all messages from source tickets into the target ticket chronologically.
 * Source tickets are archived after merge.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { target_ticket_id, source_ticket_ids } = body as { target_ticket_id: string; source_ticket_ids: string[] };

  if (!target_ticket_id || !source_ticket_ids?.length) {
    return NextResponse.json({ error: "target_ticket_id and source_ticket_ids required" }, { status: 400 });
  }

  if (source_ticket_ids.includes(target_ticket_id)) {
    return NextResponse.json({ error: "Target ticket cannot be in source list" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify target ticket exists
  const { data: target } = await admin.from("tickets")
    .select("id, workspace_id, subject")
    .eq("id", target_ticket_id).single();
  if (!target) return NextResponse.json({ error: "Target ticket not found" }, { status: 404 });

  // Get agent display name
  const { data: member } = await admin.from("workspace_members")
    .select("display_name")
    .eq("workspace_id", target.workspace_id)
    .eq("user_id", user.id).single();
  const agentName = member?.display_name || "Agent";

  let totalMoved = 0;

  for (const sourceId of source_ticket_ids) {
    const { data: source } = await admin.from("tickets")
      .select("id, subject, workspace_id")
      .eq("id", sourceId).single();
    if (!source || source.workspace_id !== target.workspace_id) continue;

    // Move all messages from source to target
    const { data: messages } = await admin.from("ticket_messages")
      .select("id")
      .eq("ticket_id", sourceId);

    if (messages?.length) {
      await admin.from("ticket_messages")
        .update({ ticket_id: target_ticket_id })
        .eq("ticket_id", sourceId);
      totalMoved += messages.length;
    }

    // Add merge note to target
    await admin.from("ticket_messages").insert({
      ticket_id: target_ticket_id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `${agentName} merged ticket "${source.subject || sourceId}" into this ticket (${messages?.length || 0} messages).`,
    });

    // Archive source ticket
    await admin.from("tickets").update({
      status: "archived",
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", sourceId);
  }

  return NextResponse.json({
    success: true,
    target_ticket_id,
    merged_count: source_ticket_ids.length,
    messages_moved: totalMoved,
  });
}
