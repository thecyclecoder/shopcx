/**
 * POST /api/checkout/log-error
 *
 * The storefront checkout client posts here whenever something blocks the
 * customer (client-token load failure, Braintree tokenize error, validation
 * stop, OTP failure, submit error). We resolve the workspace from the cart so a
 * caller can't write errors for an arbitrary workspace. Public (storefront).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCheckoutError, type CheckoutErrorStage } from "@/lib/checkout-error-log";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    cart_token?: string;
    stage?: string;
    error_code?: string;
    error_message?: string;
    context?: Record<string, unknown>;
    anonymous_id?: string;
  };
  if (!body.cart_token) return NextResponse.json({ ok: false }, { status: 200 });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id, customer_id, anonymous_id")
    .eq("token", body.cart_token)
    .maybeSingle();
  if (!cart) return NextResponse.json({ ok: false }, { status: 200 });

  await logCheckoutError({
    workspaceId: cart.workspace_id as string,
    stage: (body.stage as CheckoutErrorStage) || "other",
    side: "client",
    cartToken: body.cart_token,
    customerId: (cart.customer_id as string | null) || null,
    anonymousId: body.anonymous_id || (cart.anonymous_id as string | null) || null,
    errorCode: body.error_code || null,
    errorMessage: body.error_message || null,
    context: body.context || {},
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
