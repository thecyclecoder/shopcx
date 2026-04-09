import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { launchJourneyForTicket } from "@/lib/journey-delivery";

const TIER_INTENTS: Record<number, string> = {
  1: "crisis_tier1",
  2: "crisis_tier2",
  3: "crisis_tier3",
};

const TIER_LEAD_INS: Record<number, string> = {
  1: "Here are the available flavors — pick whichever you'd like:",
  2: "Here are some products you might enjoy instead:",
  3: "Let us know what you'd prefer:",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  const { tier } = await request.json();

  if (!tier || ![1, 2, 3].includes(tier)) {
    return NextResponse.json({ error: "tier must be 1, 2, or 3" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Verify workspace membership
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Get ticket
  const { data: ticket } = await admin
    .from("tickets")
    .select("channel, customer_id, tags")
    .eq("id", ticketId)
    .single();

  if (!ticket?.customer_id) {
    return NextResponse.json({ error: "Ticket has no customer" }, { status: 400 });
  }

  // Verify ticket has crisis tags
  const tags = (ticket.tags || []) as string[];
  if (!tags.some(t => t.startsWith("crisis"))) {
    return NextResponse.json({ error: "Ticket has no crisis tags" }, { status: 400 });
  }

  // Find crisis_customer_actions for this ticket
  const { data: crisisAction } = await admin
    .from("crisis_customer_actions")
    .select("id, crisis_id, subscription_id, segment, current_tier")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", ticket.customer_id)
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!crisisAction) {
    return NextResponse.json({ error: "No crisis action found for this ticket" }, { status: 404 });
  }

  // Look up journey definition by trigger_intent
  const triggerIntent = TIER_INTENTS[tier];
  const { data: journey } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("workspace_id", workspaceId)
    .eq("trigger_intent", triggerIntent)
    .eq("enabled", true)
    .maybeSingle();

  if (!journey) {
    return NextResponse.json({ error: `No journey found for ${triggerIntent}` }, { status: 404 });
  }

  const agentName = member.display_name || user.user_metadata?.full_name || "Agent";

  // Log the manual send as an internal note
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] ${agentName} manually sent crisis journey "${journey.name}" (Tier ${tier})`,
  });

  // Launch the journey
  const launched = await launchJourneyForTicket({
    workspaceId,
    ticketId,
    customerId: ticket.customer_id,
    journeyId: journey.id,
    journeyName: journey.name,
    triggerIntent: journey.trigger_intent || triggerIntent,
    channel: ticket.channel,
    leadIn: TIER_LEAD_INS[tier],
    ctaText: "Choose an Option",
  });

  return NextResponse.json({ sent: launched, journey: journey.name });
}
