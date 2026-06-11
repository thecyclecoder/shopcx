/**
 * GET /api/popup/land?t=<token>  (storefront-mvp Phase 4f)
 *
 * Cross-device redeem landing. The SMS/email coupon link points here. We verify
 * the signed token, set the identity cookie (sx_customer → identity stitch +
 * cross-device attribution) and the popup_coupon cookie (auto-apply at cart /
 * checkout + client price reflection), then 302 the visitor onto the exact PDP
 * they were browsing — discount already in effect. Public (under /api/popup).
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifyPopupLink } from "@/lib/popup/redeem-link";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t") || "";
  const payload = verifyPopupLink(token);

  // Cart-recovery links go straight to checkout with the abandoned cart restored
  // and the coupon applied; popup links land on the PDP with the confetti modal.
  let dest: URL;
  if (payload?.dest === "checkout" && payload.cart) {
    // Apply the coupon to the abandoned draft so checkout reflects it.
    try {
      const admin = createAdminClient();
      const { resolveCoupon, couponDiscountCents } = await import("@/lib/coupons");
      const { data: cart } = await admin
        .from("cart_drafts")
        .select("subtotal_cents, status")
        .eq("token", payload.cart)
        .maybeSingle();
      if (cart && cart.status === "open") {
        const resolved = await resolveCoupon(payload.ws, payload.code, payload.c);
        const discountCents = resolved ? couponDiscountCents(resolved, (cart.subtotal_cents as number) || 0) : 0;
        await admin.from("cart_drafts").update({
          discount_code: payload.code,
          discount_cents: discountCents,
          total_cents: ((cart.subtotal_cents as number) || 0) - discountCents,
          updated_at: new Date().toISOString(),
        }).eq("token", payload.cart);
      }
    } catch { /* non-fatal — checkout re-resolves the coupon anyway */ }
    dest = new URL("/checkout", request.nextUrl.origin);
  } else {
    const handle = payload?.h && /^[a-z0-9-]+$/i.test(payload.h) ? payload.h : "";
    dest = new URL(handle ? `/${handle}` : "/", request.nextUrl.origin);
    // Tag the landing so the PDP shows the "coupon applied" confetti modal once.
    if (payload) dest.searchParams.set("applied", "1");
  }

  const res = NextResponse.redirect(dest, 302);

  if (payload) {
    // Identity (httpOnly — server reads it for binding + stitch).
    res.cookies.set("sx_customer", payload.c, {
      path: "/", maxAge: 60 * 60 * 24 * 60, httpOnly: true, sameSite: "lax", secure: true,
    });
    // Coupon (NOT httpOnly — checkout client + price reflection read it).
    res.cookies.set("popup_coupon", payload.code, {
      path: "/", maxAge: 60 * 60 * 24 * 7, httpOnly: false, sameSite: "lax", secure: true,
    });
    // Restore the abandoned cart so /checkout loads it.
    if (payload.cart) {
      res.cookies.set("cart", payload.cart, {
        path: "/", maxAge: 60 * 60 * 24 * 7, httpOnly: false, sameSite: "lax", secure: true,
      });
    }
  }
  return res;
}
