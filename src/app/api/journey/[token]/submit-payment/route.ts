import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { vaultAndMigratePaymentMethod } from "@/lib/vault-and-migrate-payment-method";
import { inngest } from "@/lib/inngest/client";

/**
 * POST /api/journey/[token]/submit-payment
 *
 * Vault + migrate submit path for the add_payment_method journey (spec-add-
 * payment-method-journey.md). Migration ordering = Option A migrate-first
 * (synchronous) — the customer is fully on internal billing before we complete
 * the session. On vault failure the session stays `in_progress` (fail closed:
 * no completion, no signal, client shows retry).
 *
 * Shares one code path with the portal's updatePaymentMethod handler via
 * src/lib/vault-and-migrate-payment-method.ts so the two flows never drift.
 *
 * On success (Phase 3):
 *   • Records the payment result under `responses._payment_result`
 *     (payment_method_id + migrated_count) — so migratedCount is reflected on
 *     the journey_sessions row per the Phase 2 verification.
 *   • Writes `payment_method_id` into `tickets.playbook_context` so the
 *     downstream playbook step can consume it directly (matches how
 *     shipping_address writes `validated_address` there).
 *   • Compare-and-set completes the session: `status='completed' +
 *     outcome='completed' + completed_at=now`, gated on
 *     `.in('status', ['pending','in_progress']).eq('workspace_id', ...)`. Zero
 *     rows returned ⇒ session already completed by a concurrent tab ⇒ do NOT
 *     re-fire the signal (exactly-once guarantee per the Phase 3 verification).
 *   • Fires ONE `ticket/inbound-message` sentinel with body
 *     "payment_method_added" — the same resume-after-journey mechanism the
 *     shipping_address journey uses ("address_confirmed") and the cancel
 *     playbook resumes on. unified-ticket-handler.ts:648 whitelists this
 *     sentinel so it wakes the playbook without being processed as a real
 *     customer message.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, ticket_id, status, token_expires_at, responses")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (new Date(session.token_expires_at) < new Date() && session.status !== "completed") {
    await admin.from("journey_sessions").update({ status: "expired" }).eq("id", session.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (session.status !== "in_progress" && session.status !== "pending") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const nonce = typeof body?.paymentMethodNonce === "string" ? body.paymentMethodNonce.trim() : "";
  const deviceData = typeof body?.deviceData === "string" ? body.deviceData.trim() : undefined;
  if (!nonce) return NextResponse.json({ error: "missing_payment_method_nonce" }, { status: 400 });

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, first_name, last_name")
    .eq("id", session.customer_id)
    .single();
  if (!customer?.email) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  // Vault → save → migrate — synchronous. Vault failure keeps the session
  // in_progress (fail closed): the client shows a retry, no completion signal.
  let result;
  try {
    result = await vaultAndMigratePaymentMethod({
      workspaceId: session.workspace_id,
      customerId: customer.id,
      customerEmail: customer.email,
      customerFirstName: (customer.first_name as string | null) || null,
      customerLastName: (customer.last_name as string | null) || null,
      paymentMethodNonce: nonce,
      deviceData,
      makeDefault: true,
      migrate: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (session.ticket_id) {
      await admin.from("ticket_messages").insert({
        ticket_id: session.ticket_id,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[System] add_payment_method journey vault failed: ${msg}`,
      });
    }
    if (msg === "no_braintree_customer") {
      return NextResponse.json({ error: "no_braintree_customer" }, { status: 400 });
    }
    return NextResponse.json({ error: "vault_failed", message: msg }, { status: 502 });
  }

  // Record migratedCount + payment_method_id on the session's `responses`
  // JSONB — Phase 2 verification requires migratedCount on the session row.
  const responses = (session.responses as Record<string, unknown>) || {};
  const paymentResult = {
    payment_method_id: result.paymentMethodId,
    migrated_count: result.migratedCount,
    card_brand: result.vaulted.cardBrand,
    last4: result.vaulted.last4,
  };
  const nextResponses = { ...responses, _payment_result: paymentResult };

  // Compare-and-set: atomically transition ['pending','in_progress'] →
  // 'completed' + outcome='completed', gated on workspace_id. Zero rows
  // returned ⇒ a concurrent tab already completed the session; we bail
  // WITHOUT re-firing the signal (Phase 3 verification: signal fires exactly
  // once). This also blocks resurrecting an expired/abandoned row from a
  // stale async read.
  const completedAt = new Date().toISOString();
  const { data: updated } = await admin
    .from("journey_sessions")
    .update({
      responses: nextResponses,
      status: "completed",
      outcome: "completed",
      completed_at: completedAt,
    })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .in("status", ["pending", "in_progress"])
    .select("id");

  if (!updated || updated.length !== 1) {
    // Already completed by a concurrent request — return the same success
    // payload but do NOT re-fire the signal.
    return NextResponse.json({
      ok: true,
      already_completed: true,
      payment_method_id: result.paymentMethodId,
      migrated_count: result.migratedCount,
      card_brand: result.vaulted.cardBrand,
      last4: result.vaulted.last4,
    });
  }

  // Write payment_method_id into the ticket's playbook_context so the
  // downstream playbook step can consume it directly — mirrors how
  // shipping_address writes `validated_address` here (complete/route.ts).
  if (session.ticket_id) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("playbook_context")
      .eq("id", session.ticket_id)
      .maybeSingle();
    const ctx = (ticket?.playbook_context || {}) as Record<string, unknown>;
    ctx.payment_method_id = result.paymentMethodId;
    ctx.payment_method_added_at = completedAt;
    ctx.payment_method_last4 = result.vaulted.last4 || null;
    ctx.payment_method_card_brand = result.vaulted.cardBrand || null;
    ctx.payment_migrated_count = result.migratedCount;
    await admin
      .from("tickets")
      .update({ playbook_context: ctx })
      .eq("id", session.ticket_id);
  }

  const brand = result.vaulted.cardBrand || "card";
  const last4 = result.vaulted.last4 || "????";

  // Emit an EXACTLY-ONE-COPY internal + external ticket message so the ticket
  // reads identically regardless of channel (mini-site vs live chat parity
  // per Phase 3 spec).
  if (session.ticket_id) {
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] add_payment_method journey completed — ${brand} ending ${last4} on file${result.migratedCount ? ` (migrated ${result.migratedCount} sub(s) to internal)` : ""}. payment_method_id=${result.paymentMethodId}`,
    });
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id,
      direction: "outbound",
      visibility: "external",
      author_type: "system",
      body: `<p>Your ${brand} ending in ${last4} is on file. We'll use it for your future orders.</p>`,
      sent_at: completedAt,
    });

    // Fire the resume signal — SAME mechanism as shipping_address /
    // items_selected. unified-ticket-handler.ts:648 whitelists this sentinel
    // so it wakes an active playbook without being routed as a real customer
    // message (skipping the guard would re-launch this same journey).
    // Guarded by the compare-and-set above → fires at most once per session.
    await inngest.send({
      name: "ticket/inbound-message",
      data: {
        workspace_id: session.workspace_id,
        ticket_id: session.ticket_id,
        message_body: "payment_method_added",
        channel: "system",
        is_new_ticket: false,
        journey_session_id: session.id,
        payment_method_id: result.paymentMethodId,
      },
    });
  }

  // Generic outcome-processing pipeline (analytics, remedy outcomes, etc.).
  // The journeySessionCompleted Inngest fn already guards on
  // outcome_action_taken, so this is safe to fire alongside the resume
  // sentinel.
  await inngest.send({
    name: "journey/session.completed",
    data: {
      session_id: session.id,
      outcome: "completed",
      workspace_id: session.workspace_id,
    },
  });

  return NextResponse.json({
    ok: true,
    payment_method_id: result.paymentMethodId,
    migrated_count: result.migratedCount,
    card_brand: result.vaulted.cardBrand,
    last4: result.vaulted.last4,
  });
}
