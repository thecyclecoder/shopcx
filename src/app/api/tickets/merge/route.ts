import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mergeTickets } from "@/lib/ticket-merge";

/**
 * POST: Merge multiple tickets into the newest one.
 * Moves all messages chronologically, archives old tickets with merged_into reference.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const ticketIds: string[] = body.ticket_ids || [];

  if (ticketIds.length < 2) {
    return NextResponse.json({ error: "Need at least 2 ticket IDs" }, { status: 400 });
  }

  // Get workspace from first ticket
  const admin = createAdminClient();
  const { data: ticket } = await admin.from("tickets")
    .select("workspace_id")
    .eq("id", ticketIds[0]).single();
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Get agent display name
  const { data: member } = await admin.from("workspace_members")
    .select("display_name")
    .eq("workspace_id", ticket.workspace_id)
    .eq("user_id", user.id).single();

  const result = await mergeTickets(
    ticket.workspace_id,
    ticketIds,
    member?.display_name || "Agent",
  );

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    target_ticket_id: result.targetTicketId,
    merged_count: result.mergedCount,
    messages_moved: result.messagesMoved,
  });
}
