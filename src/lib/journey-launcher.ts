/**
 * Unified journey launcher — works for both chat (inline form) and email (CTA → mini-site).
 * Builds steps, creates session, delivers via the appropriate channel.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { buildDiscountJourneySteps } from "@/lib/discount-journey-builder";
import { buildCombinedEmailJourney } from "@/lib/email-journey-builder";
import { markFirstTouch } from "@/lib/first-touch";
import crypto from "crypto";

export async function launchDiscountJourney(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  channel: string,
  journeyId: string,
): Promise<{ launched: boolean }> {
  if (channel !== "chat") {
    // Email/other channels use the email journey builder (CTA → mini-site)
    await buildCombinedEmailJourney({
      workspaceId,
      ticketId,
      customerId,
      matchedJourneyIntent: "discount_signup",
      matchedJourneyId: journeyId,
    });
    return { launched: true };
  }

  // Chat: build steps + embed multi-step form inline
  const admin = createAdminClient();

  // Check if account linking is needed first
  const { data: ticket } = await admin.from("tickets")
    .select("profile_link_completed")
    .eq("id", ticketId)
    .single();

  interface JourneyStep {
    key: string;
    type: string;
    question: string;
    subtitle?: string;
    placeholder?: string;
    options?: { value: string; label: string }[];
  }

  const allSteps: JourneyStep[] = [];
  let metadata: Record<string, unknown> = {};
  let needsLinking = false;

  // Account linking steps (if needed)
  if (!ticket?.profile_link_completed) {
    const { data: cust } = await admin.from("customers")
      .select("id, email, first_name, last_name")
      .eq("id", customerId)
      .single();

    if (cust?.first_name && cust?.last_name) {
      const { data: existingLinks } = await admin.from("customer_links").select("group_id").eq("customer_id", cust.id);
      const groupId = existingLinks?.[0]?.group_id || null;
      let alreadyLinkedIds: string[] = [];
      if (groupId) {
        const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", groupId);
        alreadyLinkedIds = (grp || []).map(m => m.customer_id);
      }
      const { data: rejections } = await admin.from("customer_link_rejections").select("rejected_customer_id").eq("customer_id", cust.id);
      const rejectedIds = (rejections || []).map(r => r.rejected_customer_id);

      const { data: matches } = await admin.from("customers")
        .select("id, email")
        .eq("workspace_id", workspaceId)
        .eq("first_name", cust.first_name)
        .eq("last_name", cust.last_name)
        .neq("id", cust.id)
        .neq("email", cust.email)
        .limit(5);

      const unlinked = (matches || []).filter(m => !alreadyLinkedIds.includes(m.id) && !rejectedIds.includes(m.id));

      if (unlinked.length > 0) {
        needsLinking = true;
        allSteps.push({
          key: "account_linking",
          type: "checklist",
          question: "Do any of these emails also belong to you?",
          subtitle: "This helps us pull up your full account details.",
          options: unlinked.map(m => ({ value: m.id, label: m.email })),
        });
        metadata.unlinkedMatches = unlinked;
        metadata.existingGroupId = groupId;
        metadata.linkCustomerId = cust.id;
      }
    }
  }

  // Discount steps
  const { steps: discountSteps, metadata: discountMeta } = await buildDiscountJourneySteps(workspaceId, customerId);
  allSteps.push(...discountSteps);
  metadata = { ...metadata, ...discountMeta, ticketId, workspaceId };

  if (allSteps.length === 0) return { launched: false };

  // Create session
  const token = crypto.randomBytes(24).toString("hex");
  await admin.from("journey_sessions").insert({
    workspace_id: workspaceId,
    journey_id: journeyId,
    customer_id: customerId,
    ticket_id: ticketId,
    token,
    token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: "in_progress",
    started_at: new Date().toISOString(),
    config_snapshot: { codeDriven: true, multiStep: true, steps: allSteps, metadata, needsLinking },
  });

  // Update ticket
  await admin.from("tickets").update({
    journey_id: journeyId,
    journey_step: 0,
    journey_data: {},
    handled_by: "Journey: discount_signup",
    ai_turn_count: 0,
  }).eq("id", ticketId);

  // Send inline form message
  const journeyPayload = JSON.stringify({ token, steps: allSteps });
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body: `I got your message and I'm going to help you.<!--JOURNEY:${journeyPayload}-->`,
  });

  // Apply step ticket status
  const { data: journeyDef } = await admin.from("journey_definitions")
    .select("step_ticket_status")
    .eq("id", journeyId)
    .single();
  const stepStatus = journeyDef?.step_ticket_status || "open";
  if (stepStatus !== "open") {
    const updates: Record<string, unknown> = { status: stepStatus };
    if (stepStatus === "closed") updates.resolved_at = new Date().toISOString();
    await admin.from("tickets").update(updates).eq("id", ticketId);
  }

  await markFirstTouch(ticketId, "journey");

  return { launched: true };
}
