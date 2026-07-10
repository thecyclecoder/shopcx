import { updateSession } from "@/lib/supabase/middleware";
import {
  SHOWCASE_COOKIE_NAME,
  verifyShowcaseToken,
} from "@/lib/showcase/auth";
import {
  INVESTORS_COOKIE_NAME,
  verifyInvestorSession,
} from "@/lib/investors/auth";
import { type NextRequest, NextResponse } from "next/server";

// HTML-limited bots — mirrors Next 16's internal list
// (next/dist/shared/lib/router/utils/html-bots). These are the crawlers Next
// classifies as botType "html" via getBotType(); on a PPR route Next forces
// blocking (non-streaming) metadata for them — see the comment in proxy() below.
const HTML_LIMITED_BOT_UA_RE =
  /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;

// DOM bot — mirrors Next 16's internal HEADLESS_BROWSER_BOT_UA_RE in
// next/dist/shared/lib/router/utils/is-bot. Matches the main Googlebot search
// crawler ("Googlebot" but NOT "Mediapartners-Google" / "AdsBot-Google" — those
// are caught by HTML_LIMITED_BOT_UA_RE above). Next classifies it as botType
// "dom" via getBotType(); the SAME `botType && isRoutePPREnabled ? false`
// short-circuit fires for "dom" as for "html", so leaving Googlebot un-neutralized
// reproduces the resume-mismatch on /widget + the other PPR routes — the residual
// signature vercel:975c7f77eb7132e6 that survived the HTML-only fix.
const HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i;

function isBotForPPR(userAgent: string): boolean {
  return HTML_LIMITED_BOT_UA_RE.test(userAgent) || HEADLESS_BROWSER_BOT_UA_RE.test(userAgent);
}

// Neutral SEO UA we substitute for any UA Next's getBotType() recognizes (html
// OR dom) so getBotType() returns undefined and the page falls through to the
// streaming-metadata branch that matches the build-time prerender shell.
const NEUTRAL_BOT_UA = "Mozilla/5.0 (compatible; ShopCXSEO/1.0; +https://shopcx.ai)";

export async function proxy(request: NextRequest) {
  // ── Showcase gate (password-gated investor/friend section) ──
  // Self-contained, surgically scoped: this branch ONLY runs for /showcase/*
  // and /api/showcase/unlock, and returns early so NO other route's behavior
  // (storefront rewrites, supabase auth, bot-UA neutralization) is affected.
  // Everything under /showcase requires a valid signed cookie EXCEPT the unlock
  // page (/showcase/unlock) and the unlock API (/api/showcase/unlock), which
  // must stay reachable so a visitor can authenticate. See src/lib/showcase/auth.ts.
  {
    const p = request.nextUrl.pathname;
    const isShowcasePage = p === "/showcase" || p.startsWith("/showcase/");
    const isUnlockApi = p === "/api/showcase/unlock";
    if (isUnlockApi) {
      // The unlock route handler validates the password + sets the cookie.
      // Let it through untouched (it's under /api/, which the supabase flow
      // would otherwise auth-gate to /login).
      return NextResponse.next();
    }
    if (isShowcasePage) {
      const isUnlockPage = p === "/showcase/unlock";
      if (isUnlockPage) return NextResponse.next();
      const token = request.cookies.get(SHOWCASE_COOKIE_NAME)?.value;
      if (verifyShowcaseToken(token)) return NextResponse.next();
      const url = request.nextUrl.clone();
      url.pathname = "/showcase/unlock";
      // Preserve the intended destination so we can bounce back post-unlock.
      url.search = "";
      if (p !== "/showcase") url.searchParams.set("from", p);
      return NextResponse.redirect(url);
    }
  }

  // ── Investors gate (magic-link-gated financial section) ──
  // Mirror of the showcase gate, surgically scoped to /investors/* and
  // /api/investors/*. Everything under /investors requires a valid signed
  // `investors_session` cookie EXCEPT the magic-link entry (/investors/enter,
  // which mints the cookie) and the /investors/expired request page. The
  // /api/investors/* handlers do their own cookie auth, so we let them through
  // (otherwise the supabase flow would auth-gate them to /login). Returns early
  // so no other route is affected. See src/lib/investors/auth.ts.
  {
    const p = request.nextUrl.pathname;
    if (p === "/api/investors" || p.startsWith("/api/investors/")) {
      return NextResponse.next();
    }
    const isInvestorsPage = p === "/investors" || p.startsWith("/investors/");
    if (isInvestorsPage) {
      const isEntry = p === "/investors/enter"; // route handler sets the cookie
      const isExpired = p === "/investors/expired"; // request-a-fresh-link surface
      // Link-preview image must be publicly fetchable so the SMS/email unfurl
      // shows the branded card (bots have no session cookie).
      const isPreviewAsset = p.startsWith("/investors/opengraph-image") || p.startsWith("/investors/twitter-image");
      if (isEntry || isExpired || isPreviewAsset) return NextResponse.next();
      const session = verifyInvestorSession(request.cookies.get(INVESTORS_COOKIE_NAME)?.value);
      if (session) return NextResponse.next();
      const url = request.nextUrl.clone();
      url.pathname = "/investors/expired";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  // ── Next 16 metadata-boundary resume-mismatch root-cause fix ──
  // With cacheComponents on, every prerendered app route is PPR and its build-time
  // static shell bakes the STREAMING metadata wrapper: <div hidden><MetadataBoundary/></div>
  // (the export prerender runs with no UA, where Next hardcodes serveStreamingMetadata=true).
  // At runtime Next's app-page handler computes (node_modules/next .../templates/app-page.js):
  //   serveStreamingMetadata = botType && isRoutePPREnabled ? false
  //     : !userAgent ? true : shouldServeStreamingMetadata(userAgent, htmlLimitedBots)
  // The leading `botType && isRoutePPREnabled` short-circuit forces the BLOCKING branch
  // (a bare <__next_metadata_boundary__>, no <div hidden>) for ANY bot Next recognizes —
  // both HTML-limited bots (botType "html") AND the headless-browser DOM bot, Googlebot
  // (botType "dom", matched separately by Next's HEADLESS_BROWSER_BOT_UA_RE in is-bot.js).
  // The short-circuit IGNORES the htmlLimitedBots config (our next.config `/(?!)/` never
  // gets a vote) and there is no equivalent config knob for the dom-bot branch at all.
  // When a bot crawl triggers an ISR revalidation the cached shell is re-rendered into that
  // blocking shape; a later resume render then throws "Expected the resume to render <div>
  // … but instead it rendered <__next_metadata_boundary__>" and React bails the page to CSR
  // (digest 34312922) — killing SSR HTML for SEO + LCP on /store, /widget, /portal, /help.
  // We can't change Next's bot regex or that short-circuit, and `dynamic` / `experimental_ppr`
  // route opt-outs are rejected under cacheComponents. So we neutralize the bot UA here:
  // getBotType() then returns undefined, the handler takes the SAME streaming branch as the
  // build-time shell (shapes match → no resume mismatch → no CSR bail), and the bot still
  // receives the fully-baked static HTML (full content + real metadata). The original UA is
  // forwarded in `x-original-user-agent` for any downstream bot-aware logic. Verified in an
  // isolated Next 16.2.9 repro: pre-fix Slackbot got a 5.8KB bare-boundary shell vs the
  // 7.1KB <div hidden> prerender; post-fix Slackbot/Bingbot/facebookexternalhit each get the
  // identical 7.1KB streaming shell as Chrome (both the direct-/store and the custom-domain
  // rewrite paths). See docs/brain/recipes/next16-metadata-boundary-csr-bail.md.
  //
  // We can't mutate the incoming request's headers (read-only) or use `new NextRequest(req,
  // {headers})` (its overload doesn't forward to the render). The forwarding mechanism that
  // works is passing `{ request: { headers } }` to every terminal NextResponse.next()/rewrite()
  // — so we compute the override headers once here and thread them through updateSession.
  const ua = request.headers.get("user-agent") || "";
  let botRequestHeaders: Headers | undefined;
  if (ua && isBotForPPR(ua)) {
    botRequestHeaders = new Headers(request.headers);
    botRequestHeaders.set("user-agent", NEUTRAL_BOT_UA);
    botRequestHeaders.set("x-original-user-agent", ua);
  }
  const botInit = botRequestHeaders ? { request: { headers: botRequestHeaders } } : undefined;

  // Machine-to-machine ingest endpoint: authenticates via its OWN Bearer token
  // (DEVELOPER_USAGE_INGEST_TOKEN, checked in the route handler), so it must
  // bypass the cookie-session auth gate below that would otherwise 307 it to
  // /login (the Mac usage-reporter POST has no session cookie). Mirrors the
  // /api/showcase/unlock exemption above. See
  // src/app/api/developer/usage/report/route.ts + docs/brain/recipes/mac-usage-reporter.md.
  if (request.nextUrl.pathname === "/api/developer/usage/report") {
    return NextResponse.next(botInit);
  }

  // Widget/API routes — bypass auth + CORS (no subdomain rewrite needed)
  if (request.nextUrl.pathname.startsWith("/api/widget/") || request.nextUrl.pathname.startsWith("/widget/") || request.nextUrl.pathname.startsWith("/api/portal/")) {
    if (request.method === "OPTIONS") {
      const res = new NextResponse(null, { status: 204 });
      res.headers.set("Access-Control-Allow-Origin", "*");
      res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.headers.set("Access-Control-Allow-Headers", "Content-Type");
      return res;
    }

    // Forward the neutralized bot UA to the /widget render so its PPR shell matches
    // the build-time streaming shell (same root cause as /store, /portal, /help).
    const response = NextResponse.next(botInit);
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    return response;
  }

  // Portal/help/storefront pages need subdomain + custom-domain rewrites — updateSession
  // handles those AND forwards the neutralized bot UA into each rewrite/next it returns.
  return await updateSession(request, botRequestHeaders);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|widget\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|json|ico|js|css)$).*)",
  ],
};
