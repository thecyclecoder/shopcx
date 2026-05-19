/**
 * POST /api/checkout/client-token
 *
 * Generates a Braintree client_token scoped to the cart's workspace.
 * Drop-in / Hosted Fields need this to render — without it the
 * payment UI can't bootstrap. We resolve the workspace via the cart
 * token rather than a query param so a stale link can't be used to
 * pull tokens for a workspace you don't have a cart in.
 *
 * Body: { cart_token: string }
 * Returns: { client_token: string }
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";

export async function POST(request: Request) {
  const { cart_token } = (await request.json().catch(() => ({}))) as { cart_token?: string };
  if (!cart_token) return NextResponse.json({ error: "cart_token required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id, status")
    .eq("token", cart_token)
    .maybeSingle();
  if (!cart) return NextResponse.json({ error: "cart_not_found" }, { status: 404 });
  if (cart.status !== "open") return NextResponse.json({ error: "cart_not_open" }, { status: 400 });

  try {
    const gateway = await getBraintreeGateway(cart.workspace_id);
    const result = await gateway.clientToken.generate({});
    if (!result.success) {
      return NextResponse.json({ error: result.message || "braintree_error" }, { status: 502 });
    }
    return NextResponse.json({ client_token: result.clientToken });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
