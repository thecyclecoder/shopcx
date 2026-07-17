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
 * See docs/brain/lifecycles/storefront-checkout.md for the architecture overview.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDatacenterIp, clientIpFromHeaders } from "@/lib/datacenter-ip";

// 1×1 transparent GIF (43 bytes). Pre-encoded so we don't recompute
// on every pixel hit.
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

// Allowlisted event_type values. Anything else is silently dropped.
// Keep in sync with docs/brain/lifecycles/storefront-checkout.md § "Defined event types."
const ALLOWED_EVENT_TYPES = new Set([
  "pdp_view",
  "pdp_engaged",
  // Blog instrumentation — non-PDP top-of-funnel content reads.
  "blog_view",
  "blog_engaged",
  // Phase 2 on-site instrumentation — chapter/scroll/CTA telemetry.
  "chapter_view",
  "chapter_dwell",
  "scroll_depth",
  "cta_click",
  "add_to_cart",
  "pack_selected",
  "customize_view",
  "upsell_added",
  "upsell_skipped",
  "lead_captured",
  "checkout_view",
  "checkout_step_completed",
  "order_placed",
  // Survey chapter (in-page quiz after the hero). These were being SILENTLY
  // DROPPED (not allowlisted), so the survey funnel + step-answer analytics read
  // zero even though the survey renders. survey_step carries the per-step answer.
  "survey_shown",
  "survey_step",
  "survey_completed",
  "survey_discount_applied",
  // Storefront experiment framework — sticky-assigned arm exposure.
  // Carries { experiment_id, variant_id, is_holdout } in meta. Dropped for
  // is_internal/is_bot sessions below (experiment attribution must stay clean).
  "experiment_exposure",
]);

// Event types that must be suppressed for internal/bot traffic at WRITE time (not
// just filtered at query time): experiment exposures, since the bandit's posteriors
// roll up directly off these rows and internal/bot noise would skew assignment.
const SKIP_FOR_INTERNAL_BOT = new Set(["experiment_exposure"]);

const MAX_BATCH = 50;

interface InboundEvent {
  event_id: string;
  event_type: string;
  product_id?: string | null;
  meta?: Record<string, unknown>;
  url?: string;
}

/** A server-resolved experiment assignment carried on the pixel flush — seeds the
 *  canonical session stamp (experiment-session-stamped-attribution Phase 1). */
interface InboundAssignment {
  experiment_id?: string;
  variant_id?: string;
  arm?: string;
  surface?: string;
}

type SessionArm = "control" | "variant" | "holdout";

/** One element of storefront_sessions.experiment_assignments. */
interface SessionAssignment {
  experiment_id: string;
  variant_id: string;
  arm: SessionArm;
  assigned_at: string;
  surface: string | null;
}

const VALID_ARMS = new Set<SessionArm>(["control", "variant", "holdout"]);

interface SessionContext {
  landing_url?: string;
  referrer?: string;
  language?: string;
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
    experiment_assignments?: InboundAssignment[];
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
    experimentAssignments: body.experiment_assignments || [],
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
      experimentAssignments: [],
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
  experimentAssignments: InboundAssignment[];
}

/**
 * Resolve the persisted lander identity from a first-touch landing_url.
 *
 * Storefront Iteration Engine Phase 2b: instead of re-parsing `?angle={slug}`
 * out of landing_url at rollup time, we stamp `advertorial_page_id` (+ its
 * `ad_campaign_id`) onto the session at pixel time. The `?angle=` param already
 * carries the variant (slug is unique per workspace+product, with `-ba`/`-reasons`
 * suffixes), so a single (workspace_id, slug) lookup fully identifies the lander.
 * Returns nulls for non-lander landings — most traffic. Best-effort.
 *
 * Called both at first INSERT and on a set-when-null re-resolve for an existing
 * session (advertorial-attribution-fix): a later pixel hit carrying the resolving
 * `?angle=` heals a row whose first touch landed without it.
 */
async function resolveLanderIds(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  landingUrl: string | null | undefined,
): Promise<{ advertorial_page_id: string | null; ad_campaign_id: string | null }> {
  const none = { advertorial_page_id: null, ad_campaign_id: null };
  if (!landingUrl) return none;
  let slug: string | null = null;
  try {
    slug = new URL(landingUrl).searchParams.get("angle");
  } catch {
    return none;
  }
  if (!slug) return none;
  const { data } = await admin
    .from("advertorial_pages")
    .select("id, campaign_id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (data) return { advertorial_page_id: data.id, ad_campaign_id: data.campaign_id ?? null };
  return none;
}

/** Parse the edge `sx_variant=experimentId:variantId[:h]` cookie. Mirrors
 *  `parseVariantCookie` in supabase/middleware.ts. */
function parseVariantCookie(
  raw: string | null | undefined,
): { experimentId: string; variantId: string; isHoldout: boolean } | null {
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { experimentId: parts[0], variantId: parts[1], isHoldout: parts[2] === "h" };
}

/**
 * Build the session experiment-stamp candidates from the two reliable, server-visible
 * sources (experiment-session-stamped-attribution Phase 1) — NOT the client
 * `experiment_exposure` event:
 *   (a) `experiment_assignments` carried on the pixel flush body — the advertorial /
 *       `resolveExperimentsForRender` arm, with its arm bucket + surface resolved at render.
 *   (b) the edge `sx_variant` cookie — the edge-served PDP arm; control vs variant is
 *       resolved with one lookup (only when the experiment isn't already stamped).
 * `alreadyStamped` lets us skip work (and the cookie lookup) for experiments the session
 * already carries — the stamp is sticky (first assignment wins).
 */
async function buildSessionAssignmentCandidates(
  admin: ReturnType<typeof createAdminClient>,
  bodyAssignments: InboundAssignment[],
  variantCookie: string | null,
  alreadyStamped: Set<string>,
): Promise<Array<Omit<SessionAssignment, "assigned_at">>> {
  const out: Array<Omit<SessionAssignment, "assigned_at">> = [];
  const seen = new Set<string>(alreadyStamped);

  for (const a of bodyAssignments || []) {
    const eid = (a.experiment_id || "").trim();
    const vid = (a.variant_id || "").trim();
    const arm = (a.arm || "") as SessionArm;
    if (!eid || !vid || !VALID_ARMS.has(arm) || seen.has(eid)) continue;
    seen.add(eid);
    out.push({ experiment_id: eid, variant_id: vid, arm, surface: a.surface || null });
  }

  const cookie = parseVariantCookie(variantCookie);
  if (cookie && !seen.has(cookie.experimentId)) {
    let arm: SessionArm = cookie.isHoldout ? "holdout" : "variant";
    if (!cookie.isHoldout) {
      // Resolve control vs variant — the cookie alone can't distinguish them.
      const { data: v } = await admin
        .from("storefront_experiment_variants")
        .select("is_control")
        .eq("id", cookie.variantId)
        .maybeSingle();
      if (v?.is_control) arm = "control";
    }
    out.push({ experiment_id: cookie.experimentId, variant_id: cookie.variantId, arm, surface: "pdp" });
  }

  return out;
}

async function persistEvents({
  request,
  workspaceId,
  anonymousId,
  customerId,
  events,
  sessionContext,
  experimentAssignments,
}: PersistParams) {
  const admin = createAdminClient();

  // Server-derived session fields. We never trust client for these.
  const ua = request.headers.get("user-agent") || "";
  const { deviceType, os, browser } = parseUA(ua);
  const ipCountry = request.headers.get("x-vercel-ip-country") || null;
  const ipRegion = request.headers.get("x-vercel-ip-country-region") || null;
  const ipCity = decodeHeader(request.headers.get("x-vercel-ip-city")) || null;

  // Internal traffic: a device flagged via the `sx_internal` cookie (set by
  // visiting ?sx_internal=1) is excluded from the funnel. Source of truth is
  // the cookie on the request — it rides along same-origin on every pixel
  // POST/beacon. Once true on a session it sticks.
  const isInternal = request.cookies.get("sx_internal")?.value === "1";

  // Bot/crawler traffic: classify the request IP as datacenter/Meta-network
  // (the ad-review crawlers) vs residential/mobile (real shoppers). We store
  // ONLY this boolean — the raw IP is never persisted. See datacenter-ip.ts.
  const isBot = isDatacenterIp(clientIpFromHeaders(request.headers));

  // Edge-served PDP arm rides on the request as the `sx_variant` cookie (same-origin).
  // Internal/bot sessions are STILL stamped (previews/QA stay inspectable) — they're
  // excluded at the reporting layer, not dropped here.
  const variantCookie = request.cookies.get("sx_variant")?.value ?? null;

  // Upsert session. ON CONFLICT (workspace_id, anonymous_id) updates
  // last_seen_at + customer_id (if newly known); first-touch
  // attribution fields are only set on INSERT, never overwritten.
  // We do this via a SELECT-then-INSERT-or-UPDATE because supabase-js
  // doesn't expose the "only on insert" column-level semantics we
  // need. Two-query pattern is fast enough; the row is keyed by a
  // unique index.
  const { data: existingSession } = await admin
    .from("storefront_sessions")
    .select("id, customer_id, is_internal, is_bot, advertorial_page_id, experiment_assignments")
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
    // Flag the session internal on a cookie-marked revisit; never un-flag.
    if (isInternal && !existingSession.is_internal) {
      updates.is_internal = true;
    }
    // Same for bot: once a datacenter hit is seen on the session, it sticks.
    if (isBot && !existingSession.is_bot) {
      updates.is_bot = true;
    }
    // Set-when-null re-resolve of the lander identity. The stamp is otherwise
    // INSERT-only (below), so a session whose first pixel hit created the row
    // without a resolving angle landing_url stays advertorial_page_id=null
    // forever — even when a later hit carries the `?angle=` that exactly
    // matches a page. Heal it here: if still null and the current landing_url
    // resolves, stamp the lander id (+ its campaign). Set-when-null only — we
    // never overwrite a non-null, and landing_url itself stays insert-only.
    if (!existingSession.advertorial_page_id) {
      const landerIds = await resolveLanderIds(admin, workspaceId, sessionContext.landing_url);
      if (landerIds.advertorial_page_id) {
        updates.advertorial_page_id = landerIds.advertorial_page_id;
        updates.ad_campaign_id = landerIds.ad_campaign_id;
      }
    }
    // Stamp the session's experiment arm(s) — sticky (first assignment per experiment
    // wins). Canonical attribution signal; merges any newly-resolved arm not already
    // present. Set-when-new only: never re-buckets an experiment the session already carries.
    const existingAssignments = (existingSession.experiment_assignments as SessionAssignment[] | null) || [];
    const stampedExperimentIds = new Set(existingAssignments.map((a) => a.experiment_id));
    const newAssignments = await buildSessionAssignmentCandidates(
      admin,
      experimentAssignments,
      variantCookie,
      stampedExperimentIds,
    );
    if (newAssignments.length) {
      const nowIso = new Date().toISOString();
      updates.experiment_assignments = [
        ...existingAssignments,
        ...newAssignments.map((a) => ({ ...a, assigned_at: nowIso })),
      ];
    }
    await admin
      .from("storefront_sessions")
      .update(updates)
      .eq("id", sessionId);
  } else {
    // Phase 2b: stamp the resolved lander identity at first touch (alongside
    // landing_url, which is likewise INSERT-only / never overwritten).
    const landerIds = await resolveLanderIds(admin, workspaceId, sessionContext.landing_url);
    // Stamp the experiment arm(s) at first touch (session-stamped attribution Phase 1).
    const firstAssignments = await buildSessionAssignmentCandidates(
      admin,
      experimentAssignments,
      variantCookie,
      new Set(),
    );
    const nowIso = new Date().toISOString();
    const { data: inserted, error } = await admin
      .from("storefront_sessions")
      // Atomic get-or-create: on the first-touch burst a new visitor's pixel events fire near-
      // simultaneously, so two requests can both miss the SELECT above and both INSERT — the loser
      // hit the (workspace_id, anonymous_id) unique constraint and logged a Postgres error (the app
      // recovered via the re-fetch below, but the constraint violation still spammed the DB log).
      // `ON CONFLICT DO NOTHING` (ignoreDuplicates) makes the loser a silent no-op — no error raised,
      // no log noise — and maybeSingle() returns null on conflict so the existing race re-fetch runs.
      .upsert(
        {
        workspace_id: workspaceId,
        anonymous_id: anonymousId,
        customer_id: customerId,
        is_internal: isInternal,
        is_bot: isBot,
        advertorial_page_id: landerIds.advertorial_page_id,
        ad_campaign_id: landerIds.ad_campaign_id,
        experiment_assignments: firstAssignments.map((a) => ({ ...a, assigned_at: nowIso })),
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
        browser_language: sessionContext.language ?? null,
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
        },
        { onConflict: "workspace_id,anonymous_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
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

  // Internal/bot traffic is excluded from experiment exposure rollups at WRITE
  // time so the bandit never learns off team/crawler noise (other event types are
  // still written and filtered at query time, as before).
  const sessionIsInternalOrBot =
    isInternal || isBot || !!existingSession?.is_internal || !!existingSession?.is_bot;

  // Filter + shape events for insert. Skip disallowed types silently
  // rather than reject the whole batch — clients can over-fire and
  // we shouldn't punish them with a 4xx that breaks page rendering.
  const rows = events
    .filter((e) => e.event_id && ALLOWED_EVENT_TYPES.has(e.event_type))
    .filter((e) => !(sessionIsInternalOrBot && SKIP_FOR_INTERNAL_BOT.has(e.event_type)))
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
