/**
 * GET /api/popup/active-offer?workspace_id=…  (storefront-mvp Phase 4f)
 *
 * Resolves the visitor's auto-applied coupon for CLIENT price reflection. The
 * code lives in the popup_coupon cookie and the owner in the httpOnly
 * sx_customer cookie — neither carries the discount VALUE, and the client can't
 * read sx_customer. So this endpoint reads both server-side, resolves + binds
 * the coupon, and returns { code, type, value } (or {}). The price tables apply
 * `value` on top of the displayed subscribe/one-time prices and show the
 * "extra discount" banner. Public (under /api/popup). Never mutates anything.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveCoupon } from "@/lib/coupons";

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspace_id") || "";
  const code = request.cookies.get("popup_coupon")?.value || "";
  const customerId = request.cookies.get("sx_customer")?.value || null;
  if (!workspaceId || !code) return NextResponse.json({});

  const resolved = await resolveCoupon(workspaceId, code, customerId);
  if (!resolved) return NextResponse.json({});

  return NextResponse.json({
    code: resolved.code,
    type: resolved.type,
    value: resolved.value,
  });
}
