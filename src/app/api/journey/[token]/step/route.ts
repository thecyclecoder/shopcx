import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { executeAccountLinkingJourney, executeDiscountJourney } from "@/lib/chat-journey";
import { buildDiscountJourneySteps } from "@/lib/discount-journey-builder";
import { sendJourneyCTA } from "@/lib/email";
import crypto from "crypto";

// POST: Submit a step response
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, ticket_id, journey_id, current_step, responses, status, token_expires_at, config_snapshot")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (new Date(session.token_expires_at) < new Date()) {
    await admin.from("journey_sessions").update({ status: "expired" }).eq("id", session.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  if (session.status !== "in_progress") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const body = await request.json();
  const { stepKey, responseValue, responseLabel } = body;

  if (!stepKey || responseValue === undefined) {
    return NextResponse.json({ error: "stepKey and responseValue required" }, { status: 400 });
  }

  const config = session.config_snapshot as { steps?: { key: string; isTerminal?: boolean }[]; codeDriven?: boolean; ticketId?: string; workspaceId?: string } || {};

  // Insert step event (append-only)
  await admin.from("journey_step_events").insert({
    session_id: session.id,
    workspace_id: session.workspace_id,
    step_index: session.current_step,
    step_key: stepKey,
    response_value: responseValue,
    response_label: responseLabel || responseValue,
  });

  // Code-driven journey: execute the journey directly (not via ai/reply-received)
  if (config.codeDriven && session.ticket_id) {
    const ticketId = session.ticket_id;
    const wsId = session.workspace_id;

    // Create inbound message on the ticket (for audit trail)
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: responseLabel || responseValue,
    });

    // Reopen ticket + reset nudge count + advance journey step
    const { data: currentTicket } = await admin.from("tickets")
      .select("journey_step, journey_id, channel")
      .eq("id", ticketId)
      .single();

    const nextStep = (currentTicket?.journey_step || 0) + 1;
    await admin.from("tickets")
      .update({ status: "open", resolved_at: null, journey_nudge_count: 0, journey_step: nextStep })
      .eq("id", ticketId);

    // Determine which journey to execute and run it directly
    const { data: journeyDef } = await admin.from("journey_definitions")
      .select("trigger_intent")
      .eq("id", currentTicket?.journey_id || session.journey_id)
      .single();

    const channel = currentTicket?.channel || "email";

    if (journeyDef?.trigger_intent === "account_linking") {
      const result = await executeAccountLinkingJourney(wsId, ticketId, responseValue, channel);
      if (result.completed) {
        await admin.from("tickets").update({ profile_link_completed: true, journey_step: 0, journey_data: {} }).eq("id", ticketId);

        // Chain into discount journey — build multi-step mini-site for email
        const discDef = await admin.from("journey_definitions")
          .select("id").eq("workspace_id", wsId).eq("trigger_intent", "discount_signup").eq("is_active", true).maybeSingle();

        if (discDef?.data && channel !== "chat") {
          await admin.from("tickets").update({
            journey_id: discDef.data.id,
            handled_by: "Journey: discount_signup",
          }).eq("id", ticketId);

          // Build multi-step discount form
          const customerId = (await admin.from("tickets").select("customer_id").eq("id", ticketId).single()).data?.customer_id;
          if (customerId) {
            const { steps, metadata } = await buildDiscountJourneySteps(wsId, customerId);
            const discToken = crypto.randomBytes(24).toString("hex");

            await admin.from("journey_sessions").insert({
              workspace_id: wsId,
              journey_id: discDef.data.id,
              customer_id: customerId,
              ticket_id: ticketId,
              token: discToken,
              token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              status: "pending",
              config_snapshot: { codeDriven: true, multiStep: true, steps, metadata, ticketId, workspaceId: wsId },
            });

            // Get customer + workspace info for the CTA email
            const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", customerId).single();
            const { data: ws } = await admin.from("workspaces").select("name, help_primary_color").eq("id", wsId).single();
            const { data: ticketForSubject } = await admin.from("tickets").select("subject, email_message_id").eq("id", ticketId).single();

            if (cust?.email) {
              await sendJourneyCTA({
                workspaceId: wsId,
                toEmail: cust.email,
                customerName: cust.first_name || "",
                journeyToken: discToken,
                contextMessage: "Great news! I've linked your accounts. Now let's get you set up with exclusive coupons.",
                workspaceName: ws?.name || "Support",
                primaryColor: ws?.help_primary_color || undefined,
                subject: `Re: ${ticketForSubject?.subject || "Your request"}`,
                buttonLabel: "Get my coupon &rarr;",
                inReplyTo: ticketForSubject?.email_message_id || null,
              });
              await admin.from("ticket_messages").insert({
                ticket_id: ticketId, direction: "outbound", visibility: "internal",
                author_type: "system", body: `[System] Sent discount journey CTA email to ${cust.email}`,
              });
            }
          }
        } else if (discDef?.data && channel === "chat") {
          // Chat: use inline forms
          await admin.from("tickets").update({
            journey_id: discDef.data.id,
            handled_by: "Journey: discount_signup",
          }).eq("id", ticketId);
          await executeDiscountJourney(wsId, ticketId, "", channel);
        }
      }
    } else if (journeyDef?.trigger_intent === "discount_signup") {
      if (channel === "chat") {
        await executeDiscountJourney(wsId, ticketId, responseValue, channel);
      }
      // Email discount responses handled by the multi-step mini-site completion endpoint
    }

    // Update session
    await admin.from("journey_sessions")
      .update({
        responses: { ...(session.responses as Record<string, unknown>), [stepKey]: { value: responseValue, label: responseLabel || responseValue } },
        current_step: session.current_step + 1,
        status: "completed",
      })
      .eq("id", session.id);

    return NextResponse.json({ nextStep: session.current_step + 1, isComplete: false, codeDriven: true });
  }

  // Step-based journey: validate and advance
  const steps = config.steps || [];
  const expectedStep = steps[session.current_step];

  if (expectedStep && expectedStep.key !== stepKey) {
    return NextResponse.json({ error: "unexpected_step", expected: expectedStep.key }, { status: 400 });
  }

  const updatedResponses = {
    ...(session.responses as Record<string, unknown>),
    [stepKey]: { value: responseValue, label: responseLabel || responseValue },
  };

  const nextStep = session.current_step + 1;
  const isComplete = nextStep >= steps.length || steps[nextStep]?.isTerminal;

  await admin
    .from("journey_sessions")
    .update({
      responses: updatedResponses,
      current_step: nextStep,
    })
    .eq("id", session.id);

  return NextResponse.json({
    nextStep,
    isComplete: !!isComplete,
  });
}
