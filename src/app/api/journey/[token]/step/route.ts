import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST: Record a step response (used by single-step code-driven journeys)
// Multi-step journeys use the /complete endpoint instead
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, ticket_id, current_step, responses, status, token_expires_at")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (new Date(session.token_expires_at) < new Date()) {
    await admin.from("journey_sessions").update({ status: "expired" }).eq("id", session.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const body = await request.json();

  // get_items: return subscription items for line item modifier (works in any session status)
  if (body.step === "get_items") {
    const config = (session as { config_snapshot?: { metadata?: Record<string, unknown> } }).config_snapshot || {};
    const metadata = (config as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
    const subscriptions = (metadata?.subscriptions as { id: string; contractId: string; items: { title: string; variant_title?: string; variant_id?: string; quantity: number }[] }[]) || [];
    const subId = body.subscription_id;
    const sub = subscriptions.find(s => s.id === subId) || subscriptions[0];
    const items = (sub?.items || []).filter(i => {
      const t = (i.title || "").toLowerCase();
      return !t.includes("shipping protection") && !t.includes("insure");
    });
    return NextResponse.json({ items });
  }

  if (session.status !== "in_progress") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  const { stepKey, responseValue, responseLabel } = body;

  if (!stepKey || responseValue === undefined) {
    return NextResponse.json({ error: "stepKey and responseValue required" }, { status: 400 });
  }

  // Record step event
  await admin.from("journey_step_events").insert({
    session_id: session.id,
    workspace_id: session.workspace_id,
    step_index: session.current_step,
    step_key: stepKey,
    response_value: responseValue,
    response_label: responseLabel || responseValue,
  });

  // Update session responses
  const responses = (session.responses as Record<string, { value: string; label: string }>) || {};
  responses[stepKey] = { value: responseValue, label: responseLabel || responseValue };

  // When the customer picks a subscription, write the UUID directly to
  // journey_sessions.subscription_id (the dedicated column). This is
  // the canonical hand-off — the cancel-journey complete handler
  // reads session.subscription_id, no metadata fishing required.
  // Surfaced on Victoria's ticket 78fda092: she picked her sub but
  // the value only landed in responses.select_subscription, and the
  // complete handler bailed because session.subscription_id was null
  // and metadata.subscriptions wasn't seeded (builder doesn't seed it
  // by design — the mini-site is the source of truth).
  const updates: Record<string, unknown> = {
    responses,
    current_step: (session.current_step || 0) + 1,
  };
  if (stepKey === "select_subscription" && typeof responseValue === "string" && /^[0-9a-f-]{36}$/i.test(responseValue)) {
    updates.subscription_id = responseValue;
  }

  await admin.from("journey_sessions").update(updates).eq("id", session.id);

  // Log to ticket
  if (session.ticket_id) {
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Journey step "${stepKey}": ${responseLabel || responseValue}`,
    });
  }

  return NextResponse.json({ success: true, step: stepKey });
}
