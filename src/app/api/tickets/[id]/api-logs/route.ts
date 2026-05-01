/**
 * API call logs for a ticket — feeds the "API Logs" tab on the
 * ticket detail page. Returns every appstle_api_calls row tied to
 * this ticket, ordered most-recent-first.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  // Workspace check via the ticket
  const { data: ticket } = await admin.from("tickets").select("workspace_id").eq("id", ticketId).maybeSingle();
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", ticket.workspace_id).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: calls } = await admin
    .from("appstle_api_calls")
    .select("id, action_type, endpoint, request_method, request_url, request_body, response_status, response_body, success, error_summary, duration_ms, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(100);

  return NextResponse.json({ calls: calls || [] });
}
