import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  INVESTORS_COOKIE_NAME,
  INVESTORS_COOKIE_MAX_AGE,
  isInvestorRole,
  mintInvestorSession,
  verifyMagicToken,
} from "@/lib/investors/auth";

// Runs on the default Node.js runtime (route handlers default to Node) so the
// crypto HMAC in src/lib/magic-link.ts + src/lib/investors/auth.ts is available.

/**
 * Investors magic-link entry. The monthly email/SMS link points here:
 *   GET /investors/enter?token=<signed magic token>
 * We verify the token, confirm the customer is still an investor|owner, then set
 * a signed httpOnly `investors_session` cookie and redirect to /investors. On any
 * failure we bounce to /investors/expired (which offers a fresh-link request).
 * The proxy leaves /investors/enter un-gated so this is always reachable.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const expired = () => {
    const url = request.nextUrl.clone();
    url.pathname = "/investors/expired";
    url.search = "";
    return NextResponse.redirect(url, { status: 303 });
  };

  const payload = verifyMagicToken(token);
  if (!payload?.customerId) return expired();

  // Re-check the role at click time — a revoked investor can't ride an old link in.
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, comp_role")
    .eq("id", payload.customerId)
    .maybeSingle();
  if (!customer || !isInvestorRole(customer.comp_role)) return expired();

  const url = request.nextUrl.clone();
  url.pathname = "/investors";
  url.search = "";
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set(INVESTORS_COOKIE_NAME, mintInvestorSession(customer.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: INVESTORS_COOKIE_MAX_AGE,
  });
  return res;
}
