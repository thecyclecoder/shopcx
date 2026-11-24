/**
 * Server-side cart endpoint. cart_drafts is the canonical state —
 * client never trusts client-side prices.
 *
 *   GET    /api/cart                     Read the current cart from the `cart` cookie.
 *   POST   /api/cart                     Create or mutate a cart. Server validates every
 *                                        line item against current product_variants +
 *                                        pricing_rules.
 *   POST   /api/cart/identify            Attach an email (and optionally phone) to the
 *                                        current draft. Triggers identity-stitch backfill
 *                                        of session + events. (Handled in a separate
 *                                        sub-route file.)
 *
 * Cart token is a long random hex string set as the `cart` cookie
 * on first write. Cookie is HttpOnly so the client can't forge it.
 * Token-bound — same draft persists across navigation, devices (once
 * identified), and up to 30 days inactivity (expires_at).
 *
 * Pricing model:
 *   - subtotal_cents     = sum(line_items[].price_cents * quantity)
 *                          where price_cents reflects current rule + variant.
 *   - subscribe_discount = applied per line when mode='subscribe' and the
 *                          product's pricing_rule has subscribe_discount_pct.
 *   - discount_cents     = explicit code-applied discount (TODO: not in
 *                          this slice — POST body only stores discount_code).
 *   - shipping_cents     = 0 here. Free-shipping / threshold logic moves
 *                          to /api/checkout where we have address + carrier.
 *   - tax_cents          = 0 here. Same reasoning.
 *   - total_cents        = subtotal - discount + shipping + tax.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCartAttachments } from "@/lib/cart-gifts";
import { priceCartLines, type StoredLineItem } from "@/lib/shopping-agent/cart";
import crypto from "crypto";

const COOKIE_NAME = "cart";
const COOKIE_DAYS = 30;

interface LineItemInput {
  /** Either shopify_variant_id or internal variant_id. */
  variant_id?: string;
  shopify_variant_id?: string;
  quantity: number;
}

interface PostBody {
  workspace_id: string;
  anonymous_id?: string;
  email?: string;
  phone?: string;
  line_items: LineItemInput[];
  mode?: "subscribe" | "onetime";
  frequency_days?: number | null;
  discount_code?: string | null;
  /**
   * Product handle of the PDP the customer was on when they added to
   * cart. Persisted on the draft so the customize page can offer a
   * "← Keep shopping" link back to the originating product instead of
   * the homepage — keeps the funnel exclusive. Set on first create;
   * subsequent mutations don't overwrite a stamped value.
   */
  source_product_handle?: string | null;
}

// `StoredLineItem` is the canonical cart line shape — imported from the shared pricing lib
// (src/lib/shopping-agent/cart.ts) so the route + the MCP build_cart tool share one definition.

export async function GET(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ cart: null });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("*")
    .eq("token", token)
    .eq("status", "open")
    .maybeSingle();

  if (!cart) return NextResponse.json({ cart: null });
  return NextResponse.json({ cart });
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body.workspace_id || !Array.isArray(body.line_items)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Resolve + price every line through the SHARED pricing chokepoint (src/lib/shopping-agent/cart.ts),
  // the same code path the MCP build_cart tool uses — client price displays are advisory; what we
  // store here is the truth. Quantity breaks apply CROSS-PRODUCT at the cart-wide total.
  const mode = body.mode ?? "subscribe";
  const priced = await priceCartLines(
    admin,
    body.workspace_id,
    body.line_items.map((li) => ({ variant_id: li.variant_id, shopify_variant_id: li.shopify_variant_id, quantity: li.quantity })),
    mode,
    body.frequency_days ?? null,
  );
  if (priced.error) {
    return NextResponse.json(
      { error: priced.error.code, variant_id: priced.error.variant_id },
      { status: 400 },
    );
  }
  const resolvedLines: StoredLineItem[] = priced.lines;
  const resolvedFreqDays = priced.resolvedFreqDays;

  // Inject offer-attached items + qualifying free gifts as $0 lines
  // (server is the authority; offers may override the rule free_gift
  // for that variant per the offer's flag).
  const linesWithGifts = await ensureCartAttachments(body.workspace_id, resolvedLines);

  const subtotalCents = linesWithGifts.reduce((sum, l) => sum + l.line_total_cents, 0);

  // Resolve the auto-applied popup coupon so the live cart total + the
  // customize page reflect it. The code rides the popup_coupon cookie; the
  // owner rides the httpOnly sx_customer cookie (set at claim / land), and
  // derived codes only resolve for their owner. /api/checkout re-resolves
  // authoritatively at charge time — this is the display number.
  const couponCode = body.discount_code || request.cookies.get("popup_coupon")?.value || null;
  const couponCustomerId = request.cookies.get("sx_customer")?.value || null;
  let discountCents = 0;
  if (couponCode) {
    try {
      const { resolveCoupon, couponDiscountCents } = await import("@/lib/coupons");
      const resolved = await resolveCoupon(body.workspace_id, couponCode, couponCustomerId);
      if (resolved) discountCents = couponDiscountCents(resolved, subtotalCents);
    } catch { /* display-only — never block the cart on coupon resolution */ }
  }
  const shippingCents = 0;        // computed at /api/checkout
  const taxCents = 0;             // computed at /api/checkout
  const totalCents = subtotalCents - discountCents + shippingCents + taxCents;

  // Reuse existing token from cookie OR mint a new one.
  const existingToken = request.cookies.get(COOKIE_NAME)?.value;
  const token = existingToken || crypto.randomBytes(24).toString("hex");
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + COOKIE_DAYS * 86_400_000).toISOString();

  // Don't overwrite an already-stamped source_product_handle on
  // subsequent mutations (the customize page adds upsells via this
  // same endpoint, and those calls don't include the handle —
  // overwriting with null would lose the original PDP attribution).
  let existingHandle: string | null = null;
  if (existingToken) {
    const { data: prior } = await admin
      .from("cart_drafts")
      .select("source_product_handle")
      .eq("token", existingToken)
      .maybeSingle();
    existingHandle = (prior?.source_product_handle as string | null) || null;
  }
  const sourceHandle = existingHandle || body.source_product_handle || null;

  // Upsert the draft. The unique index on token resolves the conflict.
  const { data: cart, error } = await admin
    .from("cart_drafts")
    .upsert(
      {
        workspace_id: body.workspace_id,
        token,
        anonymous_id: body.anonymous_id || null,
        email: body.email || null,
        phone: body.phone || null,
        line_items: linesWithGifts,
        // Auto-apply the popup's customer-scoped coupon: when the smart
        // popup claimed one (phone step), it set a `popup_coupon` cookie so
        // the discount lands on the cart the visitor creates afterwards,
        // without ever showing the code on screen.
        discount_code: body.discount_code || request.cookies.get("popup_coupon")?.value || null,
        subscription_frequency_days: mode === "subscribe" ? resolvedFreqDays : null,
        subtotal_cents: subtotalCents,
        discount_cents: discountCents,
        shipping_cents: shippingCents,
        tax_cents: taxCents,
        total_cents: totalCents,
        status: "open",
        source_product_handle: sourceHandle,
        expires_at: expiresAt,
        updated_at: nowIso,
      },
      { onConflict: "token" },
    )
    .select()
    .single();

  if (error || !cart) {
    return NextResponse.json({ error: error?.message || "cart_write_failed" }, { status: 500 });
  }

  const res = NextResponse.json({ cart });
  // (Re-)set the cookie on every successful write so a fresh draft
  // gets its token cookie set and an existing one refreshes its TTL.
  res.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_DAYS * 86_400,
  });
  return res;
}

export async function DELETE(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return NextResponse.json({ ok: true });

  const admin = createAdminClient();
  await admin
    .from("cart_drafts")
    .update({ status: "abandoned", updated_at: new Date().toISOString() })
    .eq("token", token);

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_NAME);
  return res;
}
