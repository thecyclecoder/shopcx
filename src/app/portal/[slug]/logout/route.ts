/**
 * Portal logout — clears all session cookies and redirects to the login page.
 *
 * This is a Route Handler (not a page) on purpose: App Router only allows
 * cookie MUTATION inside a Route Handler or Server Action, never during a
 * Server Component render. The old page.tsx set cookies in render, which throws
 * "Cookies can only be modified in a Server Action or Route Handler."
 *
 * Reached by a GET navigation from the portal "Sign out" link. On the customer
 * custom domain middleware rewrites /logout → /portal/{slug}/logout; on
 * localhost / path-based shopcx.ai the link already carries the /portal/{slug}
 * prefix (see portalHref in src/lib/portal-nav.ts).
 */
import { type NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  // On the customer-facing subdomain (portal.example.com) middleware rewrites
  // /login → /portal/{slug}/login, so target the clean path. On shopcx.ai /
  // localhost there's no rewrite — keep the full /portal/{slug} prefix.
  const host = request.headers.get("host") || "";
  const isOnCustomDomain =
    !host.endsWith("shopcx.ai") && !host.includes("localhost") && !host.includes("127.0.0.1");
  const target = isOnCustomDomain ? "/login" : `/portal/${slug}/login`;

  const response = NextResponse.redirect(new URL(target, request.url));

  // Delete every cookie that might hold a customer session. Explicit empty
  // value + maxAge:0 (expires immediately) with the SAME path/flags the
  // cookies were set with, so the browser actually drops them. Set-Cookie on a
  // redirect response is honored before the browser follows the redirect.
  for (const name of ["portal_customer_id", "portal_workspace_id", "portal_session"]) {
    response.cookies.set({
      name,
      value: "",
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }

  return response;
}
