/**
 * GET /api/checkout/payment-methods?cart_token=...
 *
 * Returns the authenticated customer's saved payment methods so the
 * checkout client can render a "Pay with •••4242" picker above the
 * new-card Hosted Fields form. Returns an empty list when the
 * customer isn't authenticated.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSessionFromRequest } from "@/lib/auth-session";
import { linkGroupIds } from "@/lib/customer-links";

export async function GET(request: NextRequest) {
  const cartToken = request.nextUrl.searchParams.get("cart_token");
  if (!cartToken) return NextResponse.json({ methods: [] });

  const session = readSessionFromRequest(request);
  if (!session) return NextResponse.json({ methods: [] });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id")
    .eq("token", cartToken)
    .maybeSingle();
  if (!cart || cart.workspace_id !== session.w) return NextResponse.json({ methods: [] });

  // Saved cards span the customer's linked-account group — a card vaulted on
  // any linked profile is usable here (e.g. •••9801 on one account + amex •••008
  // on another).
  const groupIds = await linkGroupIds(admin, session.w, session.c);
  const { data: pms } = await admin
    .from("customer_payment_methods")
    .select("id, braintree_payment_method_token, card_brand, last4, expiration_month, expiration_year, is_default, payment_type, paypal_email")
    .eq("workspace_id", session.w)
    .in("customer_id", groupIds)
    .eq("status", "active")
    // Braintree-vaulted only — exclude Shopify-sourced methods (no BT token,
    // not chargeable through our gateway).
    .not("braintree_payment_method_token", "is", null)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  // Drop expired cards — Braintree would reject them at charge time, so don't
  // even offer them. A card is valid through the END of its expiration month.
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const notExpired = (m: { expiration_year: number | null; expiration_month: number | null }) => {
    const ey = Number(m.expiration_year), em = Number(m.expiration_month);
    if (!ey || !em) return true; // unknown expiry — keep (charge-time will catch it)
    return ey > curYear || (ey === curYear && em >= curMonth);
  };

  // De-dupe by Braintree token (the same card can be vaulted on >1 linked
  // profile) so we don't render it twice.
  const seen = new Set<string>();
  const methods = (pms || [])
    .filter(notExpired)
    .filter((m) => {
      const key = (m.braintree_payment_method_token as string) || `${m.card_brand}-${m.last4}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((m) => ({
      id: m.id,
      token: m.braintree_payment_method_token,
      brand: m.card_brand,
      last4: m.last4,
      exp_month: m.expiration_month,
      exp_year: m.expiration_year,
      is_default: m.is_default,
      payment_type: m.payment_type,
      paypal_email: m.paypal_email,
    }));

  return NextResponse.json({ methods });
}
