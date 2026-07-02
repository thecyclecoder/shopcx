/**
 * POST /api/client-errors
 *
 * The PUBLIC ingest for client-side errors — the MISSING FOURTH error feed. The
 * storefront (PDP / customize / checkout / thank-you) and both portals (in-house
 * + Shopify-extension) post here when a window.onerror / unhandledrejection fires
 * or a React island crashes. We record it into the SAME grouped error_events
 * store as the inngest / vercel / supabase feeds, under source 'client', so the
 * Control Tower shows it as its own "Client errors" panel.
 *
 * Generalizes /api/checkout/log-error (which stays as the per-cart funnel
 * diagnostic into checkout_errors): this one is the cross-surface health feed.
 *
 * Untrusted input (it's in the user's browser, no auth):
 *   - Size-cap + validate the payload; a garbage/oversized body is rejected, not stored.
 *   - Dedup by signature (recordError folds a burst into ONE incident, count bumps);
 *     a coarse per-IP rate limit caps DISTINCT signatures so a flapping client can't
 *     flood error_events.
 *   - PII-stripped at the reporter (page path only, no query/tokens) and capped here.
 *   - Fail-open: a bad request returns 200 { ok:false } — we never make the page's
 *     break worse by 500-ing its error report.
 *
 * A heartbeat body ({ heartbeat:true }) records a liveness beat WITHOUT an incident
 * so the panel can read green "connected · 0 errors" instead of amber "awaiting".
 *
 * Posted with a text/plain body (CORS-safelisted "simple" request — the Shopify
 * portal is cross-origin and sendBeacon survives unload). We parse text → JSON.
 *
 * See docs/brain/specs/client-error-capture.md · docs/brain/tables/error_events.md.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  isTransientClientNetworkAbort,
  recordError,
  recordFeedDelivery,
} from "@/lib/control-tower/error-feed";
import type { ClientErrorSurface } from "@/lib/client-error-reporter";

const VALID_SURFACES: ReadonlySet<string> = new Set<ClientErrorSurface>([
  "storefront-pdp",
  "storefront-customize",
  "checkout",
  "thank-you",
  "portal",
  "storefront",
]);

const MAX_BODY_BYTES = 16 * 1024; // 16 KB — a stack + message + path fits easily; reject anything bigger.
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_PAGE = 300;

// Coarse per-IP rate limit: cap how many DISTINCT incidents one client can open per
// window (recordError already collapses a same-signature burst into one). In-memory /
// per-instance — a best-effort backstop, not a hard guarantee. Heartbeats are exempt.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 30;
const ipHits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = ipHits.get(ip);
  if (!cur || now > cur.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (ipHits.size > 5000) for (const [k, v] of ipHits) if (now > v.resetAt) ipHits.delete(k);
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_MAX_PER_WINDOW;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    if (!raw || raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false }, { status: 200, headers: CORS });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ ok: false }, { status: 200, headers: CORS });
    }

    const surface = String(body.surface ?? "");
    if (!VALID_SURFACES.has(surface)) {
      return NextResponse.json({ ok: false }, { status: 200, headers: CORS });
    }

    // A heartbeat just proves the feed is live (panel green) — no incident recorded.
    if (body.heartbeat === true) {
      await recordFeedDelivery("client");
      return NextResponse.json({ ok: true }, { status: 200, headers: CORS });
    }

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    if (rateLimited(ip)) {
      return NextResponse.json({ ok: false, throttled: true }, { status: 200, headers: CORS });
    }

    const message = String(body.message ?? "").slice(0, MAX_MESSAGE).trim();
    if (!message) {
      return NextResponse.json({ ok: false }, { status: 200, headers: CORS });
    }
    const page = String(body.page ?? "/").split("?")[0].split("#")[0].slice(0, MAX_PAGE) || "/";
    const stack = body.stack ? String(body.stack).slice(0, MAX_STACK) : null;
    const userAgent =
      (body.userAgent ? String(body.userAgent) : request.headers.get("user-agent") || "").slice(0, 400) || null;

    await recordError({
      source: "client",
      // Group by surface + page + the (normalized) message — recordError strips the
      // volatile bits so "row 4821" and "row 9173" collapse to one incident.
      keyParts: [surface, page, message],
      title: `${surface} · ${page}: ${message}`.slice(0, 300),
      detail: stack ? `${message}\n${stack}` : message,
      sample: { surface, page, message, stack, userAgent },
      // Browser network-abort TypeErrors (Safari 'Load failed' etc. with an empty stack)
      // are one-off aborted-fetch noise — auto-resolve first sighting, escalate only on
      // recurrence within the window.
      transient: isTransientClientNetworkAbort(message, stack),
    });
    // Prove the feed is live (so a connected, clean panel reads green not amber).
    await recordFeedDelivery("client");

    return NextResponse.json({ ok: true }, { status: 200, headers: CORS });
  } catch {
    // Fail-open — never 500 a client's error report.
    return NextResponse.json({ ok: false }, { status: 200, headers: CORS });
  }
}
