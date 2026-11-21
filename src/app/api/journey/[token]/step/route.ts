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
    .select("id, workspace_id, ticket_id, customer_id, current_step, responses, status, token_expires_at")
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

  // ── Win-back "restart my subscription" (reactivate-journey-builder) ──
  // A single-step journey only reaches this route, never /complete — so the restart must happen
  // HERE, synchronously, and the customer must be told the real result (not "we'll email you").
  // Same reactivation path as the portal: src/lib/subscription-reactivate.ts.
  if (stepKey === "reactivate_choice") {
    const result = await handleReactivateChoice(admin, session, responseValue, responses);
    return NextResponse.json({ success: true, step: stepKey, ...result });
  }

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

type StepSession = {
  id: string; workspace_id: string; ticket_id: string | null; customer_id: string | null;
};

async function handleReactivateChoice(
  admin: ReturnType<typeof createAdminClient>,
  session: StepSession,
  choice: string,
  responses: Record<string, { value: string; label: string }>,
): Promise<{ outcome: string; message: string }> {
  const note = async (body: string) => {
    if (!session.ticket_id) return;
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id, direction: "outbound", visibility: "internal", author_type: "system", body,
    });
  };
  const finish = async (outcome: string, subscriptionId: string | null) => {
    await admin.from("journey_sessions").update({
      status: "completed",
      outcome,
      responses,
      completed_at: new Date().toISOString(),
      // The action already ran here; the outcome processor must not run it a second time.
      outcome_action_taken: true,
      ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
    }).eq("id", session.id);
  };

  if (choice !== "reactivate") {
    await finish("declined", null);
    await note("[Win-back] Customer chose \"Not right now\". No change made.");
    return { outcome: "declined", message: "No problem. Your subscription stays off, and you can restart it anytime." };
  }

  if (!session.customer_id) {
    await note("[Win-back] ⚠ Restart clicked but the session has no customer. Nothing restarted — needs manual follow-up.");
    return { outcome: "error", message: "We couldn't restart it automatically. Our team will reach out shortly to finish it for you." };
  }

  const { resolveTargetSubscription } = await import("@/lib/reactivate-journey-builder");
  const sub = await resolveTargetSubscription(admin, session.workspace_id, session.customer_id);
  if (!sub?.shopify_contract_id) {
    await finish("error_no_target_sub", null);
    await note("[Win-back] ⚠ Restart clicked but no cancelled or paused subscription was found. Nothing restarted — needs manual follow-up.");
    return { outcome: "error_no_target_sub", message: "We couldn't find a subscription to restart. Our team will reach out shortly to help." };
  }

  const { reactivateSubscription } = await import("@/lib/subscription-reactivate");
  const r = await reactivateSubscription(session.workspace_id, String(sub.shopify_contract_id));
  if (!r.ok) {
    const needsCard = r.reason === "needs_payment_method";
    const needsAddress = r.reason === "needs_address";
    await finish(needsCard ? "reactivate_needs_payment_method" : needsAddress ? "reactivate_needs_address" : "reactivate_failed", sub.id as string);
    await note(`[Win-back] ⚠ Restart clicked but NOT applied (${r.reason}): ${r.message}. Needs follow-up.`);
    console.error(`[journey-step] reactivate FAILED contract=${sub.shopify_contract_id} reason=${r.reason}: ${r.message}`);
    return {
      outcome: "reactivate_failed",
      message: needsCard
        ? "Almost there. We need an updated card before we can restart your subscription. Our team will send you a secure link to update it."
        : needsAddress
          ? "Almost there. We need your shipping address before we can restart your subscription. Our team will reach out to confirm it."
          : "We couldn't restart it automatically. Our team will reach out shortly to finish it for you.",
    };
  }

  await finish("reactivated", sub.id as string);
  const when = new Date(r.nextBillingDate).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  await note(`[Win-back] Customer restarted their subscription (contract ${r.contractId}). Next order: ${when}.`);
  const { logCustomerEvent } = await import("@/lib/customer-events");
  await logCustomerEvent({
    workspaceId: session.workspace_id,
    customerId: session.customer_id,
    eventType: "journey.subscription.reactivated",
    source: "journey",
    summary: "Customer restarted their subscription from the win-back journey",
    properties: { shopify_contract_id: r.contractId, next_billing_date: r.nextBillingDate, revived_on_shopcx: r.revivedOnShopcx },
  });
  return { outcome: "reactivated", message: `You're all set! Your subscription is back on, and your next order processes on ${when}.` };
}
