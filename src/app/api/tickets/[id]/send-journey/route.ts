import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { executeAccountLinkingJourney, executeDiscountJourney } from "@/lib/chat-journey";

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

  // Verify membership
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Get journey definition
  const { data: journey } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("id", journeyId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!journey) return NextResponse.json({ error: "Journey not found" }, { status: 404 });

  // Get ticket
  const { data: ticket } = await admin
    .from("tickets")
    .select("channel, customer_id, profile_link_completed")
    .eq("id", ticketId)
    .single();

  if (!ticket?.customer_id) return NextResponse.json({ error: "Ticket has no customer" }, { status: 400 });

  const agentName = member.display_name || user.user_metadata?.full_name || "Agent";

  // Set up journey on the ticket
  await admin.from("tickets").update({
    journey_id: journey.id,
    journey_step: 0,
    journey_data: {},
    journey_nudge_count: 0,
    handled_by: `Journey: ${journey.trigger_intent}`,
  }).eq("id", ticketId);

  // Log that the agent sent the journey
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] ${agentName} sent the "${journey.name}" journey to customer`,
  });

  // Execute the journey (which will send CTA email for email channel, or inline form for chat)
  let result = { completed: false };

  // Try account linking first if not completed
  if (!ticket.profile_link_completed && journey.trigger_intent !== "account_linking") {
    const linkResult = await executeAccountLinkingJourney(workspaceId, ticketId, "", ticket.channel);
    if (!linkResult.completed) {
      return NextResponse.json({ sent: true, journey: journey.name, step: "account_linking" });
    }
    await admin.from("tickets").update({ profile_link_completed: true, journey_step: 0, journey_data: {} }).eq("id", ticketId);
  }

  if (journey.trigger_intent === "account_linking") {
    const r = await executeAccountLinkingJourney(workspaceId, ticketId, "", ticket.channel);
    result = { completed: r.completed };
  } else if (journey.trigger_intent === "discount_signup") {
    const r = await executeDiscountJourney(workspaceId, ticketId, "", ticket.channel);
    result = { completed: r.completed };
  }

  return NextResponse.json({ sent: true, journey: journey.name, completed: result.completed });
}
