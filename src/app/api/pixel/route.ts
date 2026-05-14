/**
 * Storefront pixel — single ingestion endpoint for all funnel events.
 *
 * Two modes:
 *   POST   JSON batch from the browser client lib. Preferred. Lower
 *          overhead, can carry multiple events per request, supports
 *          the full session_context payload on first event.
 *   GET    Image-pixel fallback (returns 1×1 transparent GIF). For
 *          cross-domain / ad-blocker contexts where fetch/POST is
 *          blocked but <img> requests still go through. Carries a
 *          single event via query params.
 *
 * Both write to the same place: upsert into storefront_sessions
 * (keyed on workspace_id + anonymous_id), then bulk insert
 * storefront_events. Idempotent — event_id is the PK on
 * storefront_events so retried writes don't double-count.
 *
 * No auth. The endpoint is publicly callable by the storefront. We
 * keep payload validation tight: required fields, allowlisted event
 * types, max batch size, body size cap.
 *
 * See STOREFRONT.md for the architecture overview.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// 1×1 transparent GIF (43 bytes). Pre-encoded so we don't recompute
// on every pixel hit.
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

// Allowlisted event_type values. Anything else is silently dropped.
// Keep in sync with STOREFRONT.md § "Defined event types."
const ALLOWED_EVENT_TYPES = new Set([
  "pdp_view",
  "pdp_engaged",
  "pack_selected",
  "customize_view",
  "upsell_added",
  "upsell_skipped",
  "lead_captured",
  "checkout_view",
  "checkout_step_completed",
  "order_placed",
]);

const MAX_BATCH = 50;

interface InboundEvent {
  event_id: string;
  event_type: string;
  product_id?: string | null;
  meta?: Record<string, unknown>;
  url?: string;
}

interface SessionContext {
  landing_url?: string;
  referrer?: string;
  viewport_width?: number;
  viewport_height?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  fbp?: string;
  fbc?: string;
}

/**
 * POST /api/pixel
 * Body: { workspace_id, anonymous_id, events: [...], session_context?: {...} }
 */
export async function POST(request: NextRequest) {
  let body: {
    workspace_id?: string;
    anonymous_id?: string;
    events?: InboundEvent[];
    session_context?: SessionContext;
    customer_id?: string | null;
  } = {};
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const workspaceId = body.workspace_id?.trim();
  const anonymousId = body.anonymous_id?.trim();
  if (!workspaceId || !anonymousId) {
    return new NextResponse(null, { status: 400 });
  }

  const events = (body.events || []).slice(0, MAX_BATCH);
  if (events.length === 0) {
    return new NextResponse(null, { status: 204 });
  }

  await persistEvents({
    request,
    workspaceId,
    anonymousId,
    customerId: body.customer_id || null,
    events,
    sessionContext: body.session_context || {},
  });

  return new NextResponse(null, { status: 204 });
}

/**
 * GET /api/pixel?ws=...&aid=...&eid=...&et=...&...
 * Image-pixel fallback. Returns a 1×1 transparent GIF regardless of
 * success — we never want this to break a page render.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const workspaceId = sp.get("ws") || "";
  const anonymousId = sp.get("aid") || "";
  const eventId = sp.get("eid") || "";
  const eventType = sp.get("et") || "";

  if (workspaceId && anonymousId && eventId && eventType) {
    // Best-effort persistence. Don't await — caller (img tag) is
    // disconnected from us; we just need the row to land.
    persistEvents({
      request,
      workspaceId,
      anonymousId,
      customerId: null,
      events: [
        {
          event_id: eventId,
          event_type: eventType,
          product_id: sp.get("p") || null,
          url: sp.get("u") || undefined,
          meta: extractMetaFromQuery(sp),
        },
      ],
      sessionContext: {
        landing_url: sp.get("l") || undefined,
        referrer: sp.get("r") || undefined,
        utm_source: sp.get("utm_source") || undefined,
        utm_medium: sp.get("utm_medium") || undefined,
        utm_campaign: sp.get("utm_campaign") || undefined,
        utm_content: sp.get("utm_content") || undefined,
        utm_term: sp.get("utm_term") || undefined,
        fbclid: sp.get("fbclid") || undefined,
        gclid: sp.get("gclid") || undefined,
        ttclid: sp.get("ttclid") || undefined,
      },
    }).catch(() => { /* swallow — pixel must always 200 */ });
  }

  return new NextResponse(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      // Force no caching so each impression hits us. CDN cache on a
      // pixel is a self-inflicted under-count.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

/**
 * Anything past the well-known query keys becomes meta. Lets the
 * image-pixel form carry custom per-event payload (e.g. variant_id
 * for pack_selected) without a fixed schema.
 */
function extractMetaFromQuery(sp: URLSearchParams): Record<string, unknown> {
  const reserved = new Set([
    "ws", "aid", "eid", "et", "p", "u", "l", "r",
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "fbclid", "gclid", "ttclid",
  ]);
  const meta: Record<string, unknown> = {};
  for (const [k, v] of sp.entries()) {
    if (!reserved.has(k)) meta[k] = v;
  }
  return meta;
}

interface PersistParams {
  request: NextRequest;
  workspaceId: string;
  anonymousId: string;
  customerId: string | null;
  events: InboundEvent[];
  sessionContext: SessionContext;
}

async function persistEvents({
  request,
  workspaceId,
  anonymousId,
  customerId,
  events,
  sessionContext,
}: PersistParams) {
  const admin = createAdminClient();

  // Server-derived session fields. We never trust client for these.
  const ua = request.headers.get("user-agent") || "";
  const { deviceType, os, browser } = parseUA(ua);
  const ipCountry = request.headers.get("x-vercel-ip-country") || null;
  const ipRegion = request.headers.get("x-vercel-ip-country-region") || null;
  const ipCity = decodeHeader(request.headers.get("x-vercel-ip-city")) || null;

  // Upsert session. ON CONFLICT (workspace_id, anonymous_id) updates
  // last_seen_at + customer_id (if newly known); first-touch
  // attribution fields are only set on INSERT, never overwritten.
  // We do this via a SELECT-then-INSERT-or-UPDATE because supabase-js
  // doesn't expose the "only on insert" column-level semantics we
  // need. Two-query pattern is fast enough; the row is keyed by a
  // unique index.
  const { data: existingSession } = await admin
    .from("storefront_sessions")
    .select("id, customer_id")
    .eq("workspace_id", workspaceId)
    .eq("anonymous_id", anonymousId)
    .maybeSingle();

  let sessionId: string;
  if (existingSession) {
    sessionId = existingSession.id;
    const updates: Record<string, unknown> = {
      last_seen_at: new Date().toISOString(),
    };
    if (customerId && !existingSession.customer_id) {
      updates.customer_id = customerId;
    }
    await admin
      .from("storefront_sessions")
      .update(updates)
      .eq("id", sessionId);
  } else {
    const { data: inserted, error } = await admin
      .from("storefront_sessions")
      .insert({
        workspace_id: workspaceId,
        anonymous_id: anonymousId,
        customer_id: customerId,
        user_agent: ua || null,
        device_type: deviceType,
        os,
        browser,
        viewport_width: sessionContext.viewport_width ?? null,
        viewport_height: sessionContext.viewport_height ?? null,
        ip_country: ipCountry,
        ip_region: ipRegion,
        ip_city: ipCity,
        landing_url: sessionContext.landing_url ?? null,
        referrer: sessionContext.referrer ?? null,
        utm_source: sessionContext.utm_source ?? null,
        utm_medium: sessionContext.utm_medium ?? null,
        utm_campaign: sessionContext.utm_campaign ?? null,
        utm_content: sessionContext.utm_content ?? null,
        utm_term: sessionContext.utm_term ?? null,
        fbclid: sessionContext.fbclid ?? null,
        gclid: sessionContext.gclid ?? null,
        ttclid: sessionContext.ttclid ?? null,
        fbp: sessionContext.fbp ?? null,
        fbc: sessionContext.fbc ?? null,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      // Race: another request inserted between our SELECT and INSERT.
      // Re-fetch and continue.
      const { data: raceRow } = await admin
        .from("storefront_sessions")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("anonymous_id", anonymousId)
        .single();
      if (!raceRow) return;
      sessionId = raceRow.id;
    } else {
      sessionId = inserted.id;
    }
  }

  // Filter + shape events for insert. Skip disallowed types silently
  // rather than reject the whole batch — clients can over-fire and
  // we shouldn't punish them with a 4xx that breaks page rendering.
  const rows = events
    .filter((e) => e.event_id && ALLOWED_EVENT_TYPES.has(e.event_type))
    .map((e) => ({
      id: e.event_id,
      workspace_id: workspaceId,
      session_id: sessionId,
      anonymous_id: anonymousId,
      customer_id: customerId,
      event_type: e.event_type,
      product_id: e.product_id || null,
      meta: e.meta || {},
      url: e.url || null,
    }));

  if (rows.length === 0) return;

  // ON CONFLICT DO NOTHING semantics via .upsert with ignoreDuplicates.
  // event_id PK collisions = client retry of an already-stored event.
  await admin
    .from("storefront_events")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
}

/**
 * Tiny, dependency-free UA classifier. Good enough for funnel
 * segmentation (mobile vs desktop, broad OS/browser buckets). We
 * don't need pixel-precise device detection here.
 */
function parseUA(ua: string): {
  deviceType: string | null;
  os: string | null;
  browser: string | null;
} {
  if (!ua) return { deviceType: null, os: null, browser: null };
  const lower = ua.toLowerCase();

  let deviceType: string;
  if (/ipad|tablet|kindle|playbook|silk/.test(lower)) deviceType = "tablet";
  else if (/mobi|android|iphone|ipod|blackberry|opera mini|iemobile/.test(lower)) deviceType = "mobile";
  else deviceType = "desktop";

  let os: string | null = null;
  if (/iphone|ipad|ipod/.test(lower)) os = "iOS";
  else if (/android/.test(lower)) os = "Android";
  else if (/windows/.test(lower)) os = "Windows";
  else if (/macintosh|mac os x/.test(lower)) os = "macOS";
  else if (/cros/.test(lower)) os = "ChromeOS";
  else if (/linux/.test(lower)) os = "Linux";

  let browser: string | null = null;
  if (/edg\//.test(lower)) browser = "Edge";
  else if (/opr\/|opera/.test(lower)) browser = "Opera";
  else if (/chrome\//.test(lower) && !/edg\//.test(lower)) browser = "Chrome";
  else if (/firefox/.test(lower)) browser = "Firefox";
  else if (/safari/.test(lower) && !/chrome\//.test(lower)) browser = "Safari";

  return { deviceType, os, browser };
}

/**
 * Vercel encodes some IP-geo headers (notably city) as URL-encoded
 * UTF-8 so accented characters survive. Decode safely.
 */
function decodeHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
