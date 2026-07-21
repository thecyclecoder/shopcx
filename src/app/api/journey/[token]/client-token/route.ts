import { NextResponse } from "next/server";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/journey/[token]/client-token
 *
 * Braintree client token for the add-payment-method journey's Hosted Fields
 * mount. Mirrors the portal's braintreeClientToken handler
 * (src/lib/portal/handlers/braintree-client-token.ts) but auth'd by the
 * journey session's token — the mini-site is public + tokenized, no portal
 * session. Bound to the session's customer so the vaulted card attaches to
 * the right Braintree customer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, status, token_expires_at")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (new Date(session.token_expires_at) < new Date() && session.status !== "completed") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, first_name, last_name")
    .eq("id", session.customer_id)
    .single();
  if (!customer?.email) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  let braintreeCustomerId: string | null = null;
  try {
    const { resolveBraintreeCustomerId } = await import("@/lib/integrations/braintree-customer");
    braintreeCustomerId = await resolveBraintreeCustomerId({
      workspaceId: session.workspace_id,
      customerId: customer.id,
      email: customer.email,
      firstName: (customer.first_name as string | null) || undefined,
      lastName: (customer.last_name as string | null) || undefined,
    });
  } catch (err) {
    console.warn("[journey/client-token] resolveBraintreeCustomerId threw:", err);
  }

  try {
    const { getBraintreeGateway } = await import("@/lib/integrations/braintree");
    const gateway = await getBraintreeGateway(session.workspace_id);
    const opts: { customerId?: string } = {};
    if (braintreeCustomerId) opts.customerId = braintreeCustomerId;
    const result = await gateway.clientToken.generate(opts);
    if (!result.success) {
      return NextResponse.json({ error: "braintree_error", message: result.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, client_token: result.clientToken });
  } catch (err) {
    return NextResponse.json(
      { error: "braintree_error", message: errText(err) },
      { status: 500 },
    );
  }
}
