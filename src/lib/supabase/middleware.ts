import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/auth/callback", "/privacy", "/terms", "/eula", "/coming-soon", "/api/shopify/callback", "/api/webhooks", "/api/inngest", "/csat", "/api/csat", "/help", "/api/help", "/api/portal", "/portal", "/journey", "/api/journey", "/api/storefront", "/api/revalidate", "/sitemap.xml", "/robots.txt"];
const WORKSPACE_SETUP_ROUTES = ["/workspace/new", "/workspace/select"];
const ADMIN_EMAIL = "dylan@superfoodscompany.com";
const PRIMARY_DOMAINS = ["shopcx.ai", "www.shopcx.ai", "localhost"];

// ─── Storefront domain cache ────────────────────────────────────────────
// Resolves custom storefront domain → workspace storefront_slug. Cached in
// module memory with a 60s TTL so middleware stays fast at the edge.
type StorefrontCacheEntry = { slug: string | null; expiresAt: number };
const storefrontCache = new Map<string, StorefrontCacheEntry>();
const STOREFRONT_CACHE_TTL_MS = 60_000;

async function resolveStorefrontSlugByDomain(
  hostname: string,
): Promise<string | null> {
  const cached = storefrontCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.slug;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/workspaces?storefront_domain=eq.${encodeURIComponent(
        hostname,
      )}&select=storefront_slug&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const data = (await res.json()) as Array<{ storefront_slug?: string }>;
    const slug = data?.[0]?.storefront_slug || null;
    storefrontCache.set(hostname, {
      slug,
      expiresAt: Date.now() + STOREFRONT_CACHE_TTL_MS,
    });
    return slug;
  } catch {
    return null;
  }
}

export async function updateSession(request: NextRequest) {
  // ── Subdomain routing for help center mini-sites ──
  const hostname = request.headers.get("host") || "";
  const isLocalhost = hostname.includes("localhost") || hostname.includes("127.0.0.1");

  // ── Storefront routing ──
  // External URLs:
  //   shopcx.ai/store/{workspace}/{slug}  → admin preview route (noindex)
  //   custom-domain.com/{slug}            → public route; middleware
  //                                          injects x-storefront-
  //                                          workspace-slug header so
  //                                          the RSC page knows which
  //                                          workspace to load.
  {
    const pathname = request.nextUrl.pathname;
    const isInternal =
      pathname.startsWith("/_next") ||
      pathname.startsWith("/api/") ||
      pathname === "/favicon.ico";

    if (!isInternal && !isLocalhost) {
      const isPrimaryDomain = PRIMARY_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith(`.${d}`),
      );
      if (!isPrimaryDomain) {
        const storefrontSlug = await resolveStorefrontSlugByDomain(hostname);
        if (storefrontSlug) {
          const segs = pathname.split("/").filter(Boolean);
          // Single-segment paths are product handles — forward them
          // through the (storefront)/[slug] route with the workspace
          // attached as a header. Multi-segment paths fall through.
          if (segs.length === 1) {
            const forwardedHeaders = new Headers(request.headers);
            forwardedHeaders.set("x-storefront-workspace-slug", storefrontSlug);
            // Short-circuit auth — storefront is public. Without this,
            // unauthenticated visitors would bounce to /login.
            return NextResponse.rewrite(request.nextUrl, {
              request: { headers: forwardedHeaders },
            });
          }
        }
      }
    }
  }

  if (!isLocalhost) {
    const isPrimaryDomain = PRIMARY_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
    const pathname = request.nextUrl.pathname;

    // Skip fully internal paths (already rewritten or system routes)
    if (!pathname.startsWith("/help/") && !pathname.startsWith("/api/") && !pathname.startsWith("/_next")) {

      // Resolve slug from hostname
      let slug: string | null = null;

      if (!isPrimaryDomain) {
        // Custom domain — look up workspace by domain
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrl && serviceKey) {
          try {
            const res = await fetch(
              `${supabaseUrl}/rest/v1/workspaces?help_custom_domain=eq.${encodeURIComponent(hostname)}&select=help_slug&limit=1`,
              { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
            );
            const data = await res.json();
            if (data?.[0]?.help_slug) slug = data[0].help_slug;
          } catch {}
        }
      } else {
        // shopcx.ai subdomain (e.g. superfoods.shopcx.ai)
        const parts = hostname.split(".");
        if (parts.length >= 3) {
          const sub = parts[0];
          if (sub !== "www" && sub !== "app") slug = sub;
        }
      }

      if (slug) {
        const url = request.nextUrl.clone();

        // /kb/* → help center
        if (pathname.startsWith("/kb/")) {
          url.pathname = `/help/${slug}${pathname.slice(3)}`;
          return NextResponse.rewrite(url);
        }
        if (pathname === "/kb") {
          url.pathname = `/help/${slug}`;
          return NextResponse.rewrite(url);
        }

        // /portal/* → portal minisite (client-side router handles sub-paths)
        if (pathname.startsWith("/portal/") || pathname === "/portal") {
          // Only pass through /login and /callback as server routes
          const portalPath = pathname === "/portal" ? "" : pathname.slice(7);
          const isServerRoute = portalPath.endsWith("/login") || portalPath.endsWith("/callback");
          url.pathname = isServerRoute ? `/portal/${slug}${portalPath}` : `/portal/${slug}`;
          // Preserve query params (e.g. ?id=123, ?status=active)
          return NextResponse.rewrite(url);
        }

        // Root → redirect to /kb/
        if (pathname === "/") {
          url.pathname = "/kb/";
          return NextResponse.redirect(url, 301);
        }

        // Backwards compat: old help URLs without /kb/ → 301 redirect
        url.pathname = `/kb${pathname}`;
        return NextResponse.redirect(url, 301);
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
