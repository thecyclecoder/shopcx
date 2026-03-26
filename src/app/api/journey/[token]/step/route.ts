import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST: Submit a step response
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, current_step, responses, status, token_expires_at, config_snapshot")
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

  // Validate step matches expected
  const config = session.config_snapshot as { steps?: { key: string; isTerminal?: boolean }[] } || {};
  const steps = config.steps || [];
  const expectedStep = steps[session.current_step];

  if (expectedStep && expectedStep.key !== stepKey) {
    return NextResponse.json({ error: "unexpected_step", expected: expectedStep.key }, { status: 400 });
  }

  // Insert step event (append-only)
  await admin.from("journey_step_events").insert({
    session_id: session.id,
    workspace_id: session.workspace_id,
    step_index: session.current_step,
    step_key: stepKey,
    response_value: responseValue,
    response_label: responseLabel || responseValue,
  });

  // Update session responses + increment step
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
