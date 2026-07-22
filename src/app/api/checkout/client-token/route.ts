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
import { NextResponse, type NextRequest } from "next/server";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { readSessionFromRequest } from "@/lib/auth-session";
import { resolveBraintreeCustomerId } from "@/lib/integrations/braintree-customer";

export async function POST(request: NextRequest) {
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

  // If the customer has authenticated via OTP, bind the client token
  // to their Braintree customer — this lights up Drop-in's
  // vaultManager so previously-saved cards appear as one-click
  // options. Anon checkouts get a plain token (no saved cards
  // surfaced).
  const session = readSessionFromRequest(request);
  let braintreeCustomerId: string | null = null;
  if (session && session.w === cart.workspace_id) {
    const { data: customer } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("id", session.c)
      .maybeSingle();
    if (customer?.email) {
      try {
        braintreeCustomerId = await resolveBraintreeCustomerId({
          workspaceId: cart.workspace_id as string,
          customerId: customer.id as string,
          email: customer.email as string,
          firstName: (customer.first_name as string | null) || undefined,
          lastName: (customer.last_name as string | null) || undefined,
          phone: (customer.phone as string | null) || undefined,
        });
      } catch (err) {
        console.warn("[client-token] resolveBraintreeCustomerId threw:", err);
      }
    }
  }

  try {
    const gateway = await getBraintreeGateway(cart.workspace_id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {};
    if (braintreeCustomerId) opts.customerId = braintreeCustomerId;
    const result = await gateway.clientToken.generate(opts);
    if (!result.success) {
      return NextResponse.json({ error: result.message || "braintree_error" }, { status: 502 });
    }
    return NextResponse.json({
      client_token: result.clientToken,
      // Tell the client to mount Drop-in with vaultManager so saved
      // cards become first-class one-click options.
      has_saved_methods: !!braintreeCustomerId,
    });
  } catch (err) {
    const msg = errText(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
