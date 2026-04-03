import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { launchJourneyForTicket } from "@/lib/journey-delivery";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  const { journeyId } = await request.json();

  if (!journeyId) return NextResponse.json({ error: "journeyId required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: journey } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("id", journeyId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!journey) return NextResponse.json({ error: "Journey not found" }, { status: 404 });

  const { data: ticket } = await admin
    .from("tickets")
    .select("channel, customer_id")
    .eq("id", ticketId)
    .single();

  if (!ticket?.customer_id) return NextResponse.json({ error: "Ticket has no customer" }, { status: 400 });

  const agentName = member.display_name || user.user_metadata?.full_name || "Agent";

  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] ${agentName} manually sent the "${journey.name}" journey`,
  });

  const launched = await launchJourneyForTicket({
    workspaceId,
    ticketId,
    customerId: ticket.customer_id,
    journeyId: journey.id,
    journeyName: journey.name,
    triggerIntent: journey.trigger_intent || journey.name,
    channel: ticket.channel,
    leadIn: `We'd like to help you with this. Please use the form below to get started.`,
    ctaText: `${journey.name} →`,
  });

  return NextResponse.json({ sent: launched, journey: journey.name });
}
