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

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t") || "";
  const payload = verifyPopupLink(token);

  // Always land somewhere sane — a bad/expired token just drops them on the PDP
  // (or the storefront root) without the auto-apply cookies.
  const handle = payload?.h && /^[a-z0-9-]+$/i.test(payload.h) ? payload.h : "";
  const dest = new URL(handle ? `/${handle}` : "/", request.nextUrl.origin);
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
  }
  return res;
}
