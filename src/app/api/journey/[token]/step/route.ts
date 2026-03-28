import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: Submit a step response
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, ticket_id, current_step, responses, status, token_expires_at, config_snapshot")
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

  // Code-driven journey: post response as a ticket message to trigger the journey executor
  if (config.codeDriven && session.ticket_id) {
    // Create inbound message on the ticket
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: responseValue,
    });

    // Reopen ticket if closed + reset nudge count (customer completed the step)
    await admin.from("tickets")
      .update({ status: "open", resolved_at: null, journey_nudge_count: 0 })
      .eq("id", session.ticket_id);

    // Fire event to trigger the journey executor
    await inngest.send({
      name: "ai/reply-received",
      data: {
        workspace_id: session.workspace_id,
        ticket_id: session.ticket_id,
        message_body: responseValue,
      },
    });

    // Update session
    await admin.from("journey_sessions")
      .update({
        responses: { ...(session.responses as Record<string, unknown>), [stepKey]: { value: responseValue, label: responseLabel || responseValue } },
        current_step: session.current_step + 1,
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
