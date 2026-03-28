import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Check if a customer message matches any journey patterns and create
 * a suggestion message for the agent. Only runs on agent-assigned tickets.
 */
export async function suggestJourneyForAgent(
  workspaceId: string,
  ticketId: string,
  messageBody: string,
): Promise<{ suggested: boolean; journeyName?: string }> {
  const admin = createAdminClient();

  // Only suggest if ticket is assigned to a human (not AI/workflow/journey)
  const { data: ticket } = await admin
    .from("tickets")
    .select("assigned_to, handled_by, channel, journey_id, journey_step")
    .eq("id", ticketId)
    .single();

  if (!ticket) return { suggested: false };

  const handledBy = ticket.handled_by || "";
  const isAutoHandled = handledBy === "AI Agent" || handledBy.startsWith("Workflow:") || handledBy.startsWith("Journey:");

  // Only suggest for human-assigned tickets (not auto-handled, not unassigned)
  if (isAutoHandled || !ticket.assigned_to) return { suggested: false };

  // Don't suggest if a journey is already active
  if (ticket.journey_id && ticket.journey_step < 99) return { suggested: false };

  // Check for journey pattern matches
  const { data: journeyDefs } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent, match_patterns, channels")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .not("trigger_intent", "is", null)
    .order("priority", { ascending: false });

  const bodyLower = messageBody.toLowerCase();

  const matchedJourney = (journeyDefs || []).find(j => {
    if (!j.match_patterns?.length) return false;
    if (j.channels?.length && !j.channels.includes(ticket.channel)) return false;
    return j.match_patterns.some((p: string) => bodyLower.includes(p.toLowerCase()));
  });

  if (!matchedJourney) return { suggested: false };

  // Check if we already suggested this journey recently (don't spam)
  const { data: recentSuggestion } = await admin
    .from("ticket_messages")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("author_type", "system")
    .like("body", `%journey-suggest-${matchedJourney.id}%`)
    .limit(1)
    .maybeSingle();

  if (recentSuggestion) return { suggested: false };

  // Create suggestion message (internal, visible to agents only)
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `<!--JOURNEY-SUGGEST:${JSON.stringify({
      journeyId: matchedJourney.id,
      journeyName: matchedJourney.name,
      triggerIntent: matchedJourney.trigger_intent,
      markerId: `journey-suggest-${matchedJourney.id}`,
    })}-->`,
  });

  return { suggested: true, journeyName: matchedJourney.name };
}
