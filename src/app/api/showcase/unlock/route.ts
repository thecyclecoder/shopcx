import { NextResponse, type NextRequest } from "next/server";
import {
  SHOWCASE_COOKIE_NAME,
  SHOWCASE_COOKIE_MAX_AGE,
  checkShowcasePassword,
  mintShowcaseToken,
} from "@/lib/showcase/auth";

// Runs on the default Node.js runtime (route handlers default to Node), so the
// `crypto` HMAC in src/lib/showcase/auth.ts is available. The `runtime` segment
// config is intentionally omitted — it's incompatible with cacheComponents.

/**
 * Showcase unlock — validates the shared password and, on success, sets a
 * SIGNED httpOnly session cookie scoped to the whole site path (so the proxy
 * gate sees it on every /showcase/* request). Accepts a standard form POST so
 * the gate works with JS disabled; redirects back to the requested page.
 *
 * Request: POST /api/showcase/unlock  (application/x-www-form-urlencoded)
 *   password=<shared password>
 *   from=/showcase/...  (optional return path)
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  const fromRaw = String(form?.get("from") ?? "");

  // Only allow internal showcase redirects (no open-redirect).
  const dest =
    fromRaw.startsWith("/showcase/") && fromRaw !== "/showcase/unlock"
      ? fromRaw
      : "/showcase";

  if (!checkShowcasePassword(password)) {
    const url = request.nextUrl.clone();
    url.pathname = "/showcase/unlock";
    url.search = "";
    url.searchParams.set("error", "1");
    if (fromRaw.startsWith("/showcase/")) url.searchParams.set("from", fromRaw);
    return NextResponse.redirect(url, { status: 303 });
  }

  const url = request.nextUrl.clone();
  url.pathname = dest;
  url.search = "";
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.set(SHOWCASE_COOKIE_NAME, mintShowcaseToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SHOWCASE_COOKIE_MAX_AGE,
  });
  return res;
}
