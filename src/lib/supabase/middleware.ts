import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  type ExperimentManifest,
  manifestKey,
  assignFromManifest,
  EXPERIMENT_MANIFEST_PATH,
  EXPERIMENT_MANIFEST_EDGE_KEY,
} from "@/lib/storefront/experiment-manifest";

const PUBLIC_ROUTES = ["/login", "/auth/callback", "/privacy", "/terms", "/eula", "/coming-soon", "/api/shopify/callback", "/api/webhooks", "/api/inngest", "/csat", "/api/csat", "/help", "/api/help", "/api/portal", "/portal", "/journey", "/api/journey", "/api/storefront", "/api/revalidate", "/sitemap.xml", "/robots.txt", "/store/", "/storefront-img",
  // Post-Shopify storefront platform — public storefront routes +
  // the pixel/cart/lead/checkout APIs they call. Auth-gating these
  // would silent-fail the funnel for every anonymous visitor.
  "/api/pixel", "/api/cart", "/api/lead", "/api/checkout", "/api/popup",
  "/customize", "/checkout", "/thank-you", "/policies",
  // Shortlink redirector — sprfd.co/ABC123 hits this via middleware
  // rewrite; the handler returns a 302 to the campaign target URL.
  "/api/sl/",
  // Slack webhooks — Slack POSTs server-to-server with NO session; the auth is the
  // signing-secret verification inside each route, so they must bypass session auth.
  // Without this the middleware 307-redirects them to /login → buttons fail with 405.
  "/api/slack/interactions", "/api/slack/events"];
const WORKSPACE_SETUP_ROUTES = ["/workspace/new", "/workspace/select"];
const ADMIN_EMAIL = "dylan@superfoodscompany.com";
const PRIMARY_DOMAINS = ["shopcx.ai", "www.shopcx.ai", "localhost"];

// ─── Storefront domain cache ────────────────────────────────────────────
// Resolves custom storefront domain → workspace storefront_slug. Cached in
// module memory with a 60s TTL so middleware stays fast at the edge.
type StorefrontCacheEntry = { slug: string | null; expiresAt: number };
const storefrontCache = new Map<string, StorefrontCacheEntry>();
const STOREFRONT_CACHE_TTL_MS = 60_000;

// ─── Shortlink domain cache ─────────────────────────────────────────────
// Resolves a workspace's shortlink_domain (e.g. sprfd.co) to the owning
// workspace's id. Same caching pattern as storefronts.
type ShortlinkCacheEntry = { workspaceId: string | null; expiresAt: number };
const shortlinkCache = new Map<string, ShortlinkCacheEntry>();
const SHORTLINK_CACHE_TTL_MS = 60_000;

// The ONLY query params that legitimately vary the storefront PDP render (and thus
// belong in its cache key). Everything else — fbclid, fbc, fbp, gclid, ttclid,
// msclkid, every utm_*, mc_eid, … — is client-only ad-tracking noise that must NOT
// fragment the server render cache. `_sxv` (the edge experiment arm) is added by the
// proxy AFTER this strip, so it isn't in the whitelist.
const CACHE_RELEVANT_PARAMS = new Set(["variant", "angle", "sx_preview"]);

/** Rewrite `url.search` in place to keep only cache-relevant params (see above). */
function keepOnlyCacheParams(url: URL): void {
  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (CACHE_RELEVANT_PARAMS.has(k)) kept.set(k, v);
  }
  url.search = kept.toString();
}

async function resolveShortlinkWorkspaceByDomain(
  hostname: string,
): Promise<string | null> {
  const cached = shortlinkCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/workspaces?shortlink_domain=eq.${encodeURIComponent(
        hostname,
      )}&select=id&limit=1`,
      {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        // Bound the upstream — a hanging Supabase REST call must not lock the
        // middleware invocation until Vercel's 300s ceiling. On timeout the
        // AbortError falls through to the null return below (cached-negative
        // via shortlinkCache).
        signal: AbortSignal.timeout(2_000),
      },
    );
    const data = (await res.json()) as Array<{ id?: string }>;
    const workspaceId = data?.[0]?.id || null;
    shortlinkCache.set(hostname, {
      workspaceId,
      expiresAt: Date.now() + SHORTLINK_CACHE_TTL_MS,
    });
    return workspaceId;
  } catch {
    return null;
  }
}

// ─── PDP edge-served experiment manifest ────────────────────────────────
// The set of running/promoted PDP experiments, read at the edge to sticky-assign
// the variant without a per-request DB hit (pdp-edge-served-experiments). Read
// from Vercel Edge Config when provisioned, else the cached JSON-blob fallback
// route, then module-cached with a short TTL.
type ManifestCacheEntry = { data: ExperimentManifest; expiresAt: number };
let experimentManifestCache: ManifestCacheEntry | null = null;
const EXPERIMENT_MANIFEST_TTL_MS = 15_000;
// Sticky for the life of the experiment; the outcome lives in the cookie, so the
// assignment survives even when the visitor has no `sid` yet.
const SX_VARIANT_MAX_AGE = 60 * 60 * 24 * 30;

async function loadExperimentManifest(origin: string): Promise<ExperimentManifest> {
  const now = Date.now();
  if (experimentManifestCache && experimentManifestCache.expiresAt > now) {
    return experimentManifestCache.data;
  }
  let data: ExperimentManifest = {};
  try {
    const edgeConfig = process.env.EDGE_CONFIG;
    if (edgeConfig) {
      // Edge Config connection string → its HTTP item endpoint (token rides in the
      // query). Activates automatically once the owner provisions Edge Config.
      const u = new URL(edgeConfig);
      u.pathname = `${u.pathname.replace(/\/$/, "")}/item/${EXPERIMENT_MANIFEST_EDGE_KEY}`;
      // Bound the upstream (Edge Config item endpoint) — a hang here would
      // lock every PDP click; on timeout we fall through to the empty-manifest
      // cache below (no assignment, real cached PDP served).
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(2_000) });
      if (res.ok) data = ((await res.json()) as ExperimentManifest) ?? {};
    } else {
      // Fallback: the cached JSON blob the middleware fetches same-origin.
      // Same bound — a stalled same-origin fetch also degrades to empty manifest.
      const res = await fetch(`${origin}${EXPERIMENT_MANIFEST_PATH}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) data = ((await res.json()) as ExperimentManifest) ?? {};
    }
  } catch {
    data = {};
  }
  experimentManifestCache = { data, expiresAt: now + EXPERIMENT_MANIFEST_TTL_MS };
  return data;
}

/** Deterministic visitor×experiment hash → unit float in [0,1). Matches
 *  `hashToUnit` in the experiments lib (sha256, first 4 bytes / 2^32) so the edge
 *  assignment agrees with any server-side check. */
async function hashUnitEdge(key: string): Promise<number> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const b = new Uint8Array(buf);
  const int = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return int / 0x100000000;
}

function parseVariantCookie(raw: string): { experimentId: string; variantId: string; isHoldout: boolean } | null {
  const parts = raw.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { experimentId: parts[0], variantId: parts[1], isHoldout: parts[2] === "h" };
}

/**
 * Edge sticky-assignment for the bare PDP. Reads the active-experiment manifest for
 * this `(storefrontSlug, productHandle)`, reuses an existing `sx_variant` cookie or
 * assigns a fresh arm (holdout-aware, same banding as `assignVariant`), and reports
 * the `sx_variant` cookie to set + the `_sxv` rewrite param (served variants only —
 * control/holdout serve the real cached PDP). Internal/bot (`sx_internal`) opt out.
 */
async function resolvePdpEdgeAssignment(
  request: NextRequest,
  storefrontSlug: string,
  productHandle: string,
): Promise<{ cookieValue: string | null; rewriteVariantId: string | null }> {
  const none = { cookieValue: null, rewriteVariantId: null };

  // Internal/bot devices: no assignment, no rewrite, no exposure.
  if (request.cookies.get("sx_internal")?.value === "1") return none;
  // Ad-matched landers (`?variant=`) + owner preview (`?sx_preview=`) aren't the
  // bare PDP — leave those to the page. `_sxv` already present → don't double-assign.
  const qp = request.nextUrl.searchParams;
  if (qp.has("variant") || qp.has("sx_preview") || qp.has("_sxv")) return none;

  const manifest = await loadExperimentManifest(request.nextUrl.origin);
  const entry = manifest[manifestKey(storefrontSlug, productHandle)];
  if (!entry || entry.experiments.length === 0) return none;
  const exp = entry.experiments[0]; // ≤1 active campaign per surface (optimizer invariant)

  // Sticky: reuse a valid existing assignment (don't reset the cookie).
  const existing = request.cookies.get("sx_variant")?.value ?? null;
  if (existing) {
    const parsed = parseVariantCookie(existing);
    if (parsed && parsed.experimentId === exp.id) {
      const v = exp.variants.find((x) => x.id === parsed.variantId);
      const rewriteVariantId = v && !v.is_control && !parsed.isHoldout ? v.id : null;
      return { cookieValue: null, rewriteVariantId };
    }
  }

  // Fresh assignment. Identity = the `sid` anon cookie, else an ephemeral id (the
  // outcome is stored in sx_variant, so stickiness holds without sid).
  const identity = request.cookies.get("sid")?.value || crypto.randomUUID();
  const unit = await hashUnitEdge(`${identity}:${exp.id}`);
  const a = assignFromManifest(unit, exp, { conservative: true });
  if (!a) return none;
  const cookieValue = `${a.experimentId}:${a.variantId}${a.isHoldout ? ":h" : ""}`;
  const rewriteVariantId = !a.isControl && !a.isHoldout ? a.variantId : null;
  return { cookieValue, rewriteVariantId };
}

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
      {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        // Bound the upstream — a hanging Supabase REST call must not lock the
        // middleware invocation until Vercel's 300s ceiling. On timeout the
        // AbortError falls through to the null return below (cached-negative
        // via storefrontCache).
        signal: AbortSignal.timeout(2_000),
      },
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

export async function updateSession(
  request: NextRequest,
  // Next 16 metadata-boundary CSR-bail fix (see src/proxy.ts): when the caller
  // neutralized an HTML-limited bot UA, these override headers must ride along on
  // EVERY response we return (next + rewrite) so the neutralized UA reaches the
  // page render and its PPR shell matches the build-time streaming shell. Each
  // NextResponse.rewrite/next below threads `reqInit` (or the merged `rewriteInit`)
  // to forward them.
  overrideRequestHeaders?: Headers,
) {
  // `{ request: { headers } }` forwards modified request headers to the render
  // (the only mechanism in Next 16 that does). Undefined when not a bot → no-op.
  const reqInit = overrideRequestHeaders
    ? { request: { headers: overrideRequestHeaders } }
    : { request };

  // ── Subdomain routing for help center mini-sites ──
  const hostname = request.headers.get("host") || "";
  const isLocalhost = hostname.includes("localhost") || hostname.includes("127.0.0.1");

  // ── Shortlink domain routing ──
  // sprfd.co/ABC123 → rewrite to /api/sl/ABC123?ws={workspaceId}
  // First check the dedicated shortlink domain table so a short URL
  // never collides with a single-segment product handle on a
  // storefront subdomain (shortlink domains are separate by design).
  if (!isLocalhost) {
    const isPrimaryDomain = PRIMARY_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (!isPrimaryDomain) {
      const wsId = await resolveShortlinkWorkspaceByDomain(hostname);
      if (wsId) {
        const pathname = request.nextUrl.pathname;
        const segs = pathname.split("/").filter(Boolean);
        // Root → marketing landing page on the shortlink domain is
        // out of scope for v1. 404 is fine.
        // /SLUG          → bare campaign click (legacy, pre-shortcode era)
        // /SLUG/CUSTCODE → campaign click that also identifies a customer
        if (segs.length === 1 || segs.length === 2) {
          const url = request.nextUrl.clone();
          url.pathname = `/api/sl/${segs[0]}`;
          url.searchParams.set("ws", wsId);
          if (segs.length === 2) url.searchParams.set("c", segs[1]);
          return NextResponse.rewrite(url, reqInit);
        }
        // Anything else on the shortlink domain → 404 (don't fall
        // through to storefront logic).
        return new NextResponse("Not found", { status: 404 });
      }
    }
  }

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
      //    Googlebot not to index it. Covers the product PDP
      //    (/store/{ws}/{slug}, 3 segs), the blog index
      //    (/store/{ws}/blog, 3 segs) AND a blog post
      //    (/store/{ws}/blog/{handle}, 4 segs) — anything under /store/.
      if (isPrimaryDomain && pathname.startsWith("/store/")) {
        const segs = pathname.split("/").filter(Boolean);
        if (segs.length >= 3) {
          const res = NextResponse.next(reqInit);
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
          // Single-segment paths → product PDP (/{slug}) or the blog
          // index (/blog, which resolves to the /store/{ws}/blog route).
          if (
            segs.length === 1
            && segs[0] !== "favicon.ico"
            && !STOREFRONT_APP_ROUTES.has(segs[0])
          ) {
            const url = request.nextUrl.clone();
            url.pathname = `/store/${storefrontSlug}/${segs[0]}`;
            // ── Cache-key canonicalization ──
            // Strip every non-cache-relevant query param from the ORIGIN request so a
            // unique per-click `fbclid` / `utm_*` / `gclid` never fragments the render
            // cache — only `variant`, `angle`, `sx_preview` (the params the page reads
            // server-side) survive; `_sxv` is added below. This is a REWRITE, so the
            // browser URL keeps the tracking params intact and the client pixel still
            // reads them from window.location. Result: a bare Meta click collapses to
            // the prerendered PDP shell (CDN HIT) instead of a per-fbclid dynamic render.
            keepOnlyCacheParams(url);
            // ── PDP edge-served experiment (pdp-edge-served-experiments) ──
            // Sticky-assign the variant at the edge: set the `sx_variant` cookie
            // and rewrite served arms to a variant-keyed URL (`?_sxv=<variantId>`)
            // so each arm is a distinct cacheable render; control/holdout get the
            // real cached PDP. No-op when no PDP experiment runs on this surface.
            const assign = await resolvePdpEdgeAssignment(request, storefrontSlug, segs[0]);
            if (assign.rewriteVariantId) url.searchParams.set("_sxv", assign.rewriteVariantId);
            const res = NextResponse.rewrite(url, reqInit);
            if (assign.cookieValue) {
              res.cookies.set("sx_variant", assign.cookieValue, {
                path: "/",
                maxAge: SX_VARIANT_MAX_AGE,
                sameSite: "lax",
              });
            }
            return res;
          }
          // Blog post detail — /blog/{handle} → /store/{ws}/blog/{handle}.
          // Only the blog namespace is rewritten as a two-segment path so
          // we don't shadow other root routes.
          if (segs.length === 2 && segs[0] === "blog") {
            const url = request.nextUrl.clone();
            url.pathname = `/store/${storefrontSlug}/blog/${segs[1]}`;
            return NextResponse.rewrite(url, reqInit);
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
              {
                headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
                // Bound the upstream — a hanging Supabase REST call must not
                // lock the middleware invocation until Vercel's 300s ceiling.
                // On timeout the AbortError falls through to the outer try/catch
                // and slug stays null (no help/portal rewrite for this request).
                signal: AbortSignal.timeout(2_000),
              }
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
          // Skip if the path is ALREADY rewritten (avoids the
          // double-prefix bug where /portal/{slug}/login would become
          // /portal/{slug}/portal/{slug}/login — produced a 404 on
          // every login redirect from /portal/[slug]/page.tsx).
          if (pathname.startsWith(`/portal/${slug}`)) return NextResponse.next(reqInit);

          // Skip API routes / static assets — those shouldn't be
          // rewritten under the portal slug at all.
          if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) {
            return NextResponse.next(reqInit);
          }

          // Portal sections — clean per-section URLs (/subscriptions,
          // /orders, /payment-methods, /support, /account). Rewrite to
          // /portal/{slug}?section={name} so the same page handles all
          // of them. URL bar stays clean (rewrite, not redirect).
          const PORTAL_SECTIONS = new Set([
            "subscriptions", "orders", "rewards", "payment-methods", "support", "help", "account", "resources",
          ]);
          const sectionFromPath = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
          if (PORTAL_SECTIONS.has(sectionFromPath)) {
            url.pathname = `/portal/${slug}`;
            url.searchParams.set("section", sectionFromPath);
            return NextResponse.rewrite(url, reqInit);
          }

          // Subscription detail route — /subscriptions/{uuid} rewrites
          // to /portal/{slug}/subscriptions/{uuid}. UUID is our internal
          // subscriptions.id (not Shopify/Appstle contract id) so the
          // URL survives a future Shopify cutover.
          const subDetailMatch = pathname.match(/^\/subscriptions\/([0-9a-f-]{36})\/?$/i);
          if (subDetailMatch) {
            url.pathname = `/portal/${slug}/subscriptions/${subDetailMatch[1]}`;
            return NextResponse.rewrite(url, reqInit);
          }

          // Order detail route — /orders/{uuid} rewrites to
          // /portal/{slug}/orders/{uuid}. UUID is our internal
          // orders.id (the same key the commerce SDK's detail op reads).
          const orderDetailMatch = pathname.match(/^\/orders\/([0-9a-f-]{36})\/?$/i);
          if (orderDetailMatch) {
            url.pathname = `/portal/${slug}/orders/${orderDetailMatch[1]}`;
            return NextResponse.rewrite(url, reqInit);
          }

          // Server routes (login, callback, logout) — rewrite path as-is.
          const isServerRoute = pathname === "/login" || pathname === "/callback" || pathname === "/logout"
            || pathname.endsWith("/login") || pathname.endsWith("/callback") || pathname.endsWith("/logout");
          url.pathname = isServerRoute
            ? `/portal/${slug}${pathname}`
            : `/portal/${slug}`;
          return NextResponse.rewrite(url, reqInit);
        }
        if (purpose === "help") {
          // Skip if already rewritten (same double-prefix protection
          // as the portal branch).
          if (pathname.startsWith(`/help/${slug}`)) return NextResponse.next(reqInit);
          // Help center on its own subdomain (help.example.com).
          // Map every path 1:1 under /help/{slug}.
          if (pathname === "/") {
            url.pathname = `/help/${slug}`;
          } else {
            url.pathname = `/help/${slug}${pathname}`;
          }
          return NextResponse.rewrite(url, reqInit);
        }

        // ── Fallback path-prefix routing (shopcx.ai subdomain pattern) ──
        // /kb/* → help center
        if (pathname.startsWith("/kb/")) {
          url.pathname = `/help/${slug}${pathname.slice(3)}`;
          return NextResponse.rewrite(url, reqInit);
        }
        if (pathname === "/kb") {
          url.pathname = `/help/${slug}`;
          return NextResponse.rewrite(url, reqInit);
        }

        // /portal/* → portal minisite (client-side router handles sub-paths)
        if (pathname.startsWith("/portal/") || pathname === "/portal") {
          const portalPath = pathname === "/portal" ? "" : pathname.slice(7);
          const isServerRoute = portalPath.endsWith("/login") || portalPath.endsWith("/callback");
          url.pathname = isServerRoute ? `/portal/${slug}${portalPath}` : `/portal/${slug}`;
          return NextResponse.rewrite(url, reqInit);
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

  let supabaseResponse = NextResponse.next(reqInit);

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
          supabaseResponse = NextResponse.next(reqInit);
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Bound the upstream — a hanging Supabase GoTrue auth call must not lock the
  // middleware invocation until Vercel's 300s ceiling. supabase-js's auth
  // methods do not accept an AbortSignal, so race the call against a 2s timer
  // that resolves to `{ data: { user: null } }`; on timeout we fall through to
  // the existing unauthenticated branch below (public routes pass, protected
  // routes redirect to /login), which is the correct safe degradation.
  const {
    data: { user },
  } = await Promise.race([
    supabase.auth.getUser(),
    new Promise<{ data: { user: null } }>((resolve) =>
      setTimeout(() => resolve({ data: { user: null } }), 2_000),
    ),
  ]);

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
