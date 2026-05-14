import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/auth/callback", "/privacy", "/terms", "/eula", "/coming-soon", "/api/shopify/callback", "/api/webhooks", "/api/inngest", "/csat", "/api/csat", "/help", "/api/help", "/api/portal", "/portal", "/journey", "/api/journey", "/api/storefront", "/api/revalidate", "/sitemap.xml", "/robots.txt", "/store/", "/storefront-img",
  // Post-Shopify storefront platform — public storefront routes +
  // the pixel/cart/lead/checkout APIs they call. Auth-gating these
  // would silent-fail the funnel for every anonymous visitor.
  "/api/pixel", "/api/cart", "/api/lead", "/api/checkout",
  "/customize", "/checkout", "/thank-you"];
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
  // Two external URL shapes, one underlying SSG route:
  //
  //   custom-domain.com/{slug}           → rewrite to /store/{ws}/{slug}
  //   shopcx.ai/store/{workspace}/{slug} → admin preview, noindex applied
  //
  // The rewrite keeps the internal path static so Next.js can
  // pre-render it with generateStaticParams and Vercel can serve the
  // response from the edge CDN with sub-100ms TTFB. No headers() or
  // cookies() calls in the page — those would force dynamic rendering.
  {
    const pathname = request.nextUrl.pathname;
    const isInternal =
      pathname.startsWith("/_next") ||
      pathname.startsWith("/api/") ||
      pathname === "/favicon.ico";

    if (!isInternal) {
      const isPrimaryDomain =
        isLocalhost ||
        PRIMARY_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));

      // 1) Admin preview on primary domain — pass through, but tell
      //    Googlebot not to index it.
      if (isPrimaryDomain && pathname.startsWith("/store/")) {
        const segs = pathname.split("/").filter(Boolean);
        if (segs.length === 3) {
          const res = NextResponse.next({ request });
          res.headers.set("x-robots-tag", "noindex, nofollow");
          return res;
        }
      }

      // 2) Custom domain with a single-segment path — rewrite to the
      //    SSG route. Uses NextResponse.rewrite with a rewritten
      //    pathname so Next.js caches under that key; no headers
      //    injection, no dynamic rendering, no auth sideeffects.
      //
      //    EXCEPT for storefront app routes (/customize, /checkout,
      //    /thank-you) which serve at the root and must NOT be
      //    rewritten to /store/{slug}/{route} — those resolve to the
      //    workspace-scoped product SSG path, which doesn't exist for
      //    these app paths. Leaving them untouched lets the
      //    (storefront)/customize route render normally.
      if (!isPrimaryDomain && !isLocalhost) {
        const storefrontSlug = await resolveStorefrontSlugByDomain(hostname);
        if (storefrontSlug) {
          const segs = pathname.split("/").filter(Boolean);
          const STOREFRONT_APP_ROUTES = new Set(["customize", "checkout", "thank-you"]);
          if (
            segs.length === 1
            && segs[0] !== "favicon.ico"
            && !STOREFRONT_APP_ROUTES.has(segs[0])
          ) {
            const url = request.nextUrl.clone();
            url.pathname = `/store/${storefrontSlug}/${segs[0]}`;
            return NextResponse.rewrite(url);
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

      // Resolve { slug, purpose } from hostname.
      //   purpose = "help" → host serves the help-center mini-site;
      //                       every path rewrites to /help/{slug}/...
      //   purpose = "portal" → host serves the customer portal mini-site;
      //                        every path rewrites to /portal/{slug}/...
      //   purpose = "either" → fallback for shopcx.ai subdomains where
      //                        the user-facing URL still includes the
      //                        /kb or /portal prefix.
      let slug: string | null = null;
      let purpose: "help" | "portal" | "either" = "either";

      if (!isPrimaryDomain) {
        // Custom domain — try BOTH portal_config.minisite.domain and
        // help_custom_domain in one query, pick whichever matches.
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrl && serviceKey) {
          try {
            const orFilter = `or=(help_custom_domain.eq.${encodeURIComponent(hostname)},portal_config->minisite->>custom_domain.eq.${encodeURIComponent(hostname)})`;
            const res = await fetch(
              `${supabaseUrl}/rest/v1/workspaces?${orFilter}&select=help_slug,help_custom_domain,portal_config&limit=1`,
              { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
            );
            const data = await res.json();
            const ws = data?.[0];
            if (ws?.help_slug) {
              slug = ws.help_slug;
              const portalDomain = ws?.portal_config?.minisite?.custom_domain || null;
              if (portalDomain && portalDomain.toLowerCase() === hostname.toLowerCase()) {
                purpose = "portal";
              } else if (ws.help_custom_domain && ws.help_custom_domain.toLowerCase() === hostname.toLowerCase()) {
                purpose = "help";
              }
            }
          } catch {}
        }
      } else {
        // shopcx.ai subdomain (e.g. superfoods.shopcx.ai) — purpose is
        // "either"; the user-facing path still carries /kb or /portal.
        const parts = hostname.split(".");
        if (parts.length >= 3) {
          const sub = parts[0];
          if (sub !== "www" && sub !== "app") slug = sub;
        }
      }

      if (slug) {
        const url = request.nextUrl.clone();

        // ── Purpose-bound rewrite — host alone determines route prefix
        // so the customer never sees /kb or /portal in the URL.
        if (purpose === "portal") {
          // Portal mini-site on its own subdomain (portal.example.com).
          // Map / → /portal/{slug}, /login → /portal/{slug}/login (real
          // server route), everything else → /portal/{slug} (the SPA
          // handles its own sub-routing client-side).
          const isServerRoute = pathname === "/login" || pathname === "/callback"
            || pathname.endsWith("/login") || pathname.endsWith("/callback");
          url.pathname = isServerRoute
            ? `/portal/${slug}${pathname}`
            : `/portal/${slug}`;
          return NextResponse.rewrite(url);
        }
        if (purpose === "help") {
          // Help center on its own subdomain (help.example.com).
          // Map every path 1:1 under /help/{slug}.
          if (pathname === "/") {
            url.pathname = `/help/${slug}`;
          } else {
            url.pathname = `/help/${slug}${pathname}`;
          }
          return NextResponse.rewrite(url);
        }

        // ── Fallback path-prefix routing (shopcx.ai subdomain pattern) ──
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
          const portalPath = pathname === "/portal" ? "" : pathname.slice(7);
          const isServerRoute = portalPath.endsWith("/login") || portalPath.endsWith("/callback");
          url.pathname = isServerRoute ? `/portal/${slug}${portalPath}` : `/portal/${slug}`;
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
