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
  const { ticket_ids } = body as { ticket_ids: string[]; target_ticket_id?: string; source_ticket_ids?: string[] };

  // Support both formats: { ticket_ids } (auto-sort) or { target_ticket_id, source_ticket_ids } (manual)
  const admin = createAdminClient();

  let targetId: string;
  let sourceIds: string[];

  if (ticket_ids?.length >= 2) {
    // Auto-sort: oldest ticket becomes target, newest ones get merged in
    const { data: allTickets } = await admin.from("tickets")
      .select("id, created_at")
      .in("id", ticket_ids)
      .order("created_at", { ascending: true });
    if (!allTickets || allTickets.length < 2) {
      return NextResponse.json({ error: "Need at least 2 valid tickets" }, { status: 400 });
    }
    targetId = allTickets[0].id; // Oldest
    sourceIds = allTickets.slice(1).map(t => t.id); // Newest
  } else if (body.target_ticket_id && body.source_ticket_ids?.length) {
    targetId = body.target_ticket_id;
    sourceIds = body.source_ticket_ids;
  } else {
    return NextResponse.json({ error: "ticket_ids (2+) required" }, { status: 400 });
  }

  // Verify target ticket exists
  const { data: target } = await admin.from("tickets")
    .select("id, workspace_id, subject")
    .eq("id", targetId).single();
  if (!target) return NextResponse.json({ error: "Target ticket not found" }, { status: 404 });

  // Get agent display name
  const { data: member } = await admin.from("workspace_members")
    .select("display_name")
    .eq("workspace_id", target.workspace_id)
    .eq("user_id", user.id).single();
  const agentName = member?.display_name || "Agent";

  let totalMoved = 0;

  for (const sourceId of sourceIds) {
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
        .update({ ticket_id: targetId })
        .eq("ticket_id", sourceId);
      totalMoved += messages.length;
    }

    // Add merge note to target
    await admin.from("ticket_messages").insert({
      ticket_id: targetId,
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
    target_ticket_id: targetId,
    merged_count: sourceIds.length,
    messages_moved: totalMoved,
  });
}
