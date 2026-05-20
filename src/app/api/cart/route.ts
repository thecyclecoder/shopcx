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
import { findVariant } from "@/lib/product-variants";
import { ensureFreeGifts } from "@/lib/cart-gifts";
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

interface StoredLineItem {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  sku: string | null;              // Amplifier needs this to fulfill
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;        // applied price (with sub discount already factored)
  unit_msrp_cents: number;         // base variant price, pre-discount, for "save X%" math
  price_cents_at_add: number;      // snapshot at add-time — used to detect drift later
  line_total_cents: number;        // unit_price_cents * quantity
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
  /**
   * True when this line was injected by the server as a qualifying
   * free gift from a pricing_rules.free_gift_* config. Gift lines have
   * unit_price_cents=0 and line_total_cents=0; their unit_msrp_cents
   * holds the gift's perceived value (used to surface "save $X" math).
   * Gifts are excluded from per-item shipping calc and from Amplifier
   * line_items (no fulfillment SKU to ship through the 3PL).
   */
  is_gift?: boolean;
  /** When is_gift=true, the product_id of the qualifying product that triggered the gift. */
  gift_source_product_id?: string;
}

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

  // Resolve every variant against the DB. This is the price-validation
  // step — client price displays are advisory; what we store here is
  // the truth.
  const resolvedLines: StoredLineItem[] = [];
  const mode = body.mode ?? "subscribe";
  const freqDays = body.frequency_days ?? null;

  for (const li of body.line_items) {
    const qty = Math.max(1, Math.floor(li.quantity || 0));
    if (qty === 0) continue;

    const variant = await findVariant(body.workspace_id, {
      id: li.variant_id,
      shopifyVariantId: li.shopify_variant_id,
    });
    if (!variant) {
      return NextResponse.json(
        { error: "variant_not_found", variant_id: li.variant_id || li.shopify_variant_id },
        { status: 400 },
      );
    }

    // Pull the product's pricing rule to apply subscribe discount.
    // We don't apply quantity_breaks here — those are pre-grouped
    // on the storefront (Bundle-1 vs Bundle-2 etc); the cart stores
    // whatever the customer added.
    const { data: ruleAssignment } = await admin
      .from("product_pricing_rule")
      .select("pricing_rule_id")
      .eq("workspace_id", body.workspace_id)
      .eq("product_id", variant.product_id)
      .maybeSingle();
    let subDiscountPct = 0;
    if (ruleAssignment?.pricing_rule_id) {
      const { data: rule } = await admin
        .from("pricing_rules")
        .select("subscribe_discount_pct")
        .eq("id", ruleAssignment.pricing_rule_id)
        .maybeSingle();
      subDiscountPct = rule?.subscribe_discount_pct || 0;
    }

    const msrp = variant.price_cents;
    const unit = mode === "subscribe" && subDiscountPct > 0
      ? Math.round(msrp * (1 - subDiscountPct / 100))
      : msrp;

    // Product title for the line snapshot — we want it to read nicely
    // in the customize page without joining at render time.
    const { data: product } = await admin
      .from("products")
      .select("title")
      .eq("id", variant.product_id)
      .single();

    resolvedLines.push({
      variant_id: variant.id,
      product_id: variant.product_id,
      shopify_variant_id: variant.shopify_variant_id,
      sku: variant.sku || null,
      title: product?.title || "Item",
      variant_title: variant.title || null,
      image_url: variant.image_url,
      quantity: qty,
      unit_price_cents: unit,
      unit_msrp_cents: msrp,
      price_cents_at_add: unit,
      line_total_cents: unit * qty,
      mode,
      frequency_days: mode === "subscribe" ? freqDays : null,
    });
  }

  // Inject qualifying free gifts as $0 lines (server is the authority).
  const linesWithGifts = await ensureFreeGifts(body.workspace_id, resolvedLines);

  const subtotalCents = linesWithGifts.reduce((sum, l) => sum + l.line_total_cents, 0);
  const discountCents = 0;        // TODO when discount_code is applied
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
        discount_code: body.discount_code || null,
        subscription_frequency_days: mode === "subscribe" ? freqDays : null,
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
