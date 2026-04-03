import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { inngest } from "@/lib/inngest/client";

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

  const admin = createAdminClient();
  const { data: ticket } = await admin.from("tickets")
    .select("channel, customer_id")
    .eq("id", ticketId).single();

  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Get latest customer message
  const { data: lastMsg } = await admin.from("ticket_messages")
    .select("body")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1).single();

  // Trigger unified handler
  await inngest.send({
    name: "ticket/inbound-message",
    data: {
      workspace_id: workspaceId,
      ticket_id: ticketId,
      message_body: lastMsg?.body || "",
      channel: ticket.channel || "email",
      is_new_ticket: false,
    },
  });

  return NextResponse.json({ queued: true });
}
