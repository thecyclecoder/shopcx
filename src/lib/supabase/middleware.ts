import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/auth/callback", "/privacy", "/terms", "/eula", "/coming-soon", "/api/shopify/callback", "/api/webhooks", "/api/inngest", "/csat", "/api/csat", "/help", "/api/help", "/api/portal"];
const WORKSPACE_SETUP_ROUTES = ["/workspace/new", "/workspace/select"];
const ADMIN_EMAIL = "dylan@superfoodscompany.com";
const PRIMARY_DOMAINS = ["shopcx.ai", "www.shopcx.ai", "localhost"];

export async function updateSession(request: NextRequest) {
  // ── Subdomain routing for help center mini-sites ──
  const hostname = request.headers.get("host") || "";
  const isLocalhost = hostname.includes("localhost") || hostname.includes("127.0.0.1");

  if (!isLocalhost) {
    // Check if this is a help center subdomain (e.g. superfoods.shopcx.ai or help.superfoodscompany.com)
    const isPrimaryDomain = PRIMARY_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));

    if (!isPrimaryDomain) {
      // Custom domain (e.g. help.superfoodscompany.com) — look up workspace by domain
      const pathname = request.nextUrl.pathname;
      if (!pathname.startsWith("/help/") && !pathname.startsWith("/api/help/") && !pathname.startsWith("/_next")) {
        // Look up help_slug from custom domain via Supabase REST
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrl && serviceKey) {
          try {
            const res = await fetch(
              `${supabaseUrl}/rest/v1/workspaces?help_custom_domain=eq.${encodeURIComponent(hostname)}&select=help_slug&limit=1`,
              { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
            );
            const data = await res.json();
            if (data?.[0]?.help_slug) {
              const url = request.nextUrl.clone();
              url.pathname = `/help/${data[0].help_slug}${pathname === "/" ? "" : pathname}`;
              return NextResponse.rewrite(url);
            }
          } catch {}
        }
      }
    } else {
      // Check for shopcx.ai subdomain (e.g. superfoods.shopcx.ai)
      const parts = hostname.split(".");
      if (parts.length >= 3) {
        const subdomain = parts[0];
        if (subdomain !== "www" && subdomain !== "app") {
          const pathname = request.nextUrl.pathname;
          if (!pathname.startsWith("/help/") && !pathname.startsWith("/api/") && !pathname.startsWith("/_next")) {
            const url = request.nextUrl.clone();
            url.pathname = `/help/${subdomain}${pathname === "/" ? "" : pathname}`;
            return NextResponse.rewrite(url);
          }
        }
      }
    }
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublicRoute = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const isWorkspaceSetup = WORKSPACE_SETUP_ROUTES.some((r) => pathname.startsWith(r));

  // Unauthenticated users -> login (unless public route)
  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Authenticated users: check access gate
  // Middleware can't do DB queries efficiently, so we check workspace_id cookie
  // as a proxy — if they have one, they passed the gate at login.
  // The auth callback does the real authorization check.
  if (user && !isPublicRoute) {
    const isAdmin = user.email?.toLowerCase() === ADMIN_EMAIL;
    const hasWorkspaceCookie = !!request.cookies.get("workspace_id")?.value;

    // If not admin and no workspace cookie, they haven't been authorized yet
    if (!isAdmin && !hasWorkspaceCookie && !isWorkspaceSetup && !pathname.startsWith("/api")) {
      const url = request.nextUrl.clone();
      url.pathname = "/coming-soon";
      return NextResponse.redirect(url);
    }
  }

  // Authenticated users on login -> redirect based on workspace
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // Authenticated users on protected routes need a workspace
  if (user && !isPublicRoute && !isWorkspaceSetup && !pathname.startsWith("/api")) {
    const workspaceId = request.cookies.get("workspace_id")?.value;
    if (!workspaceId) {
      const url = request.nextUrl.clone();
      url.pathname = "/workspace/select";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
