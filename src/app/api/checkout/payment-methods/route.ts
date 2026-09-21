/**
 * GET /api/checkout/payment-methods?cart_token=...
 *
 * Returns the authenticated customer's saved payment methods so the
 * checkout client can render a "Pay with •••4242" picker above the
 * new-card Hosted Fields form. Returns an empty list when the
 * customer isn't authenticated.
 *
 * POST /api/checkout/payment-methods { cart_token, payment_method_nonce, device_data? }
 *
 * Vaults a Braintree nonce as a saved card on the authenticated customer's
 * link group and — critically — calls `triggerNewCardRecovery` so any open
 * dunning cycles the customer has are picked up by the same
 * `dunning/new-card-recovery` handler that the Shopify payment-method webhook
 * uses. Storefront/portal card adds used to trigger nothing, so five real
 * customers (verified 2026-09-21) vaulted a card and stayed stranded for
 * 50-72 days because their open cycles kept retrying a card that no longer
 * existed. Recovery is best-effort — a recovery-trigger failure never fails
 * the card-add itself. See [[../../../../docs/brain/lifecycles/dunning.md]]
 * § recovery.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSessionFromRequest } from "@/lib/auth-session";
import { linkGroupIds } from "@/lib/customer-links";
import { resolveBraintreeCustomerId, savePaymentMethod, vaultPaymentMethod, VaultCreateError } from "@/lib/integrations/braintree-customer";
import { triggerNewCardRecovery } from "@/lib/dunning";
import { errText } from "@/lib/error-text";

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

interface PostBody {
  cart_token?: string;
  payment_method_nonce?: string;
  device_data?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (!body.cart_token) return NextResponse.json({ error: "missing_cart_token" }, { status: 400 });
  if (!body.payment_method_nonce) return NextResponse.json({ error: "missing_nonce" }, { status: 400 });

  const session = readSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id")
    .eq("token", body.cart_token)
    .maybeSingle();
  if (!cart || cart.workspace_id !== session.w) {
    return NextResponse.json({ error: "cart_not_found" }, { status: 400 });
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, phone")
    .eq("workspace_id", session.w)
    .eq("id", session.c)
    .maybeSingle();
  if (!customer?.email) return NextResponse.json({ error: "customer_missing_email" }, { status: 400 });

  const braintreeCustomerId = await resolveBraintreeCustomerId({
    workspaceId: session.w,
    customerId: customer.id,
    email: customer.email,
    firstName: customer.first_name,
    lastName: customer.last_name,
    phone: customer.phone,
  });

  let vaulted;
  try {
    vaulted = await vaultPaymentMethod(session.w, braintreeCustomerId, body.payment_method_nonce, body.device_data);
  } catch (err) {
    if (err instanceof VaultCreateError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 402 });
    }
    return NextResponse.json({ error: "vault_failed", message: errText(err) }, { status: 500 });
  }

  const saved = await savePaymentMethod({
    workspaceId: session.w,
    customerId: customer.id,
    braintreeCustomerId,
    braintreePaymentMethodToken: vaulted.token,
    paymentType: vaulted.paymentType,
    cardBrand: vaulted.cardBrand,
    last4: vaulted.last4,
    expirationMonth: vaulted.expirationMonth,
    expirationYear: vaulted.expirationYear,
    paypalEmail: vaulted.paypalEmail,
    cartToken: body.cart_token,
    makeDefault: true,
  });

  // Best-effort recovery trigger — a card added on our storefront/portal must
  // wake any open dunning cycle for this customer, otherwise the sub silently
  // keeps retrying the dead card. Never fails the vault on a recovery error.
  // ⚠️ Pass the BRAINTREE token (not saved.id / customer_payment_methods.id UUID) —
  // internalSubSwitchPaymentMethod matches on braintree_payment_method_token.
  await triggerNewCardRecovery(session.w, customer.id, vaulted.token);

  return NextResponse.json({
    id: saved.id,
    token: vaulted.token,
    brand: vaulted.cardBrand,
    last4: vaulted.last4,
    exp_month: vaulted.expirationMonth,
    exp_year: vaulted.expirationYear,
  });
}
