/**
 * Build a combined multi-step mini-site journey for email channel.
 * Combines account linking + matched journey (e.g., discount) into a
 * single CTA email → single mini-site visit → all steps in one flow.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { sendJourneyCTA } from "@/lib/email";
import { buildDiscountJourneySteps } from "@/lib/discount-journey-builder";
import { markFirstTouch } from "@/lib/first-touch";
import crypto from "crypto";

interface JourneyStep {
  key: string;
  type: "confirm" | "radio" | "checklist" | "info";
  question: string;
  subtitle?: string;
  options?: { value: string; label: string }[];
}

export async function buildCombinedEmailJourney({
  workspaceId,
  ticketId,
  customerId,
  matchedJourneyIntent,
  matchedJourneyId,
}: {
  workspaceId: string;
  ticketId: string;
  customerId?: string;
  matchedJourneyIntent: string;
  matchedJourneyId: string;
}) {
  const admin = createAdminClient();

  if (!customerId) {
    const { data: ticket } = await admin.from("tickets").select("customer_id").eq("id", ticketId).single();
    customerId = ticket?.customer_id || undefined;
  }
  if (!customerId) return;

  const steps: JourneyStep[] = [];
  let metadata: Record<string, unknown> = { ticketId, workspaceId };

  // 1. Check if account linking is needed
  const { data: ticket } = await admin.from("tickets")
    .select("profile_link_completed, subject, email_message_id")
    .eq("id", ticketId)
    .single();

  let needsLinking = false;
  if (!ticket?.profile_link_completed) {
    const { data: cust } = await admin.from("customers")
      .select("id, email, first_name, last_name")
      .eq("id", customerId)
      .single();

    if (cust?.first_name && cust?.last_name) {
      // Get existing link group
      const { data: existingLinks } = await admin.from("customer_links").select("group_id").eq("customer_id", cust.id);
      const groupId = existingLinks?.[0]?.group_id || null;
      let alreadyLinkedIds: string[] = [];
      if (groupId) {
        const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", groupId);
        alreadyLinkedIds = (grp || []).map(m => m.customer_id);
      }

      // Get rejections
      const { data: rejections } = await admin.from("customer_link_rejections").select("rejected_customer_id").eq("customer_id", cust.id);
      const rejectedIds = (rejections || []).map(r => r.rejected_customer_id);

      // Find unlinked name matches
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
        steps.push({
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

  // 2. Build matched journey steps
  if (matchedJourneyIntent === "discount_signup") {
    const { steps: discountSteps, metadata: discountMeta } = await buildDiscountJourneySteps(workspaceId, customerId);
    steps.push(...discountSteps as JourneyStep[]);
    metadata = { ...metadata, ...discountMeta };
  }

  if (steps.length === 0) {
    // Nothing to do — fire ai/reply-received as fallback
    const { inngest } = await import("@/lib/inngest/client");
    await inngest.send({ name: "ai/reply-received", data: { workspace_id: workspaceId, ticket_id: ticketId, message_body: "" } });
    return;
  }

  // 3. Create session + send CTA
  const token = crypto.randomBytes(24).toString("hex");
  const discDef = await admin.from("journey_definitions")
    .select("id").eq("id", matchedJourneyId).single();

  await admin.from("journey_sessions").insert({
    workspace_id: workspaceId,
    journey_id: matchedJourneyId,
    customer_id: customerId,
    ticket_id: ticketId,
    token,
    token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: "pending",
    config_snapshot: {
      codeDriven: true,
      multiStep: true,
      steps,
      metadata,
      needsLinking,
    },
  });

  // Update ticket
  await admin.from("tickets").update({
    journey_id: matchedJourneyId,
    journey_step: 0,
    journey_data: {},
    handled_by: `Journey: ${matchedJourneyIntent}`,
    ai_turn_count: 0,
  }).eq("id", ticketId);

  // Get customer + workspace info
  const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", customerId).single();
  const { data: ws } = await admin.from("workspaces").select("name, help_primary_color").eq("id", workspaceId).single();

  if (cust?.email) {
    await sendJourneyCTA({
      workspaceId,
      toEmail: cust.email,
      customerName: cust.first_name || "",
      journeyToken: token,
      contextMessage: "We currently do have coupons and discounts available. I've set one up for you. Click the button below to claim your coupon!",
      workspaceName: ws?.name || "Support",
      primaryColor: ws?.help_primary_color || undefined,
      subject: `Re: ${ticket?.subject || "Your request"}`,
      buttonLabel: "Claim my coupon &rarr;",
      inReplyTo: ticket?.email_message_id || null,
    });

    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Sent combined journey CTA email to ${cust.email} (${needsLinking ? "account linking + " : ""}${matchedJourneyIntent})`,
    });

    await markFirstTouch(ticketId, "journey");
  }

  // Apply step ticket status
  const { data: journeyDef } = await admin.from("journey_definitions")
    .select("step_ticket_status")
    .eq("id", matchedJourneyId)
    .single();

  const stepStatus = journeyDef?.step_ticket_status || "open";
  if (stepStatus !== "open") {
    const updates: Record<string, unknown> = { status: stepStatus };
    if (stepStatus === "closed") updates.resolved_at = new Date().toISOString();
    await admin.from("tickets").update(updates).eq("id", ticketId);
  }
}
