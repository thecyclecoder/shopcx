import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { vaultAndMigratePaymentMethod } from "@/lib/vault-and-migrate-payment-method";

/**
 * POST /api/journey/[token]/submit-payment
 *
 * Vault + migrate submit path for the add_payment_method journey (spec-add-
 * payment-method-journey.md Phase 2). Migration ordering = Option A migrate-
 * first (synchronous) — the customer is fully on internal billing before we
 * mark the session ready to complete. On vault failure the session stays
 * `in_progress` (fail closed — no completion signal, client shows retry).
 *
 * Shares one code path with the portal's updatePaymentMethod handler via
 * src/lib/vault-and-migrate-payment-method.ts so the two flows never drift.
 *
 * Records the payment result under `responses._payment_result` (payment_method_id
 * + migrated_count) so migratedCount is reflected on journey_sessions per the
 * Phase 2 verification. Actually completing the session + emitting the resume
 * signal is Phase 3.
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
  // JSONB. Phase 3 will emit the completion signal off this same row.
  const responses = (session.responses as Record<string, unknown>) || {};
  const nextResponses = {
    ...responses,
    _payment_result: {
      payment_method_id: result.paymentMethodId,
      migrated_count: result.migratedCount,
      card_brand: result.vaulted.cardBrand,
      last4: result.vaulted.last4,
    },
  };

  // Compare-and-set: only advance a session that's STILL open (pending or
  // in_progress). An expired/completed/abandoned row in a concurrent tab must
  // not be resurrected by this write.
  const { data: updated } = await admin
    .from("journey_sessions")
    .update({ responses: nextResponses, status: "in_progress" })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .in("status", ["pending", "in_progress"])
    .select("id");

  if (!updated || updated.length !== 1) {
    return NextResponse.json({ error: "session_no_longer_open" }, { status: 409 });
  }

  if (session.ticket_id) {
    const brand = result.vaulted.cardBrand || "card";
    const last4 = result.vaulted.last4 || "????";
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] add_payment_method journey vaulted ${brand} ending ${last4}${result.migratedCount ? ` (migrated ${result.migratedCount} sub(s) to internal)` : ""}.`,
    });
  }

  return NextResponse.json({
    ok: true,
    payment_method_id: result.paymentMethodId,
    migrated_count: result.migratedCount,
    card_brand: result.vaulted.cardBrand,
    last4: result.vaulted.last4,
  });
}
