/**
 * Storefront funnel analytics. Aggregates storefront_events +
 * storefront_sessions into:
 *
 *   - Step-by-step funnel: distinct sessions that reached each event
 *     type, plus consecutive conversion rates.
 *   - Breakdowns by product, utm_source, device_type, country.
 *   - Recent event stream for live debugging.
 *
 * Date range is inclusive on both ends, interpreted in UTC against
 * created_at. Future: switch to Central time to match the rest of
 * the analytics dashboards.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const FUNNEL_STEPS = [
  "pdp_view",
  "pdp_engaged",
  "pack_selected",
  "customize_view",
  // The checkout page fires checkout_view on load — the reliable "reached
  // checkout" signal. (checkout_redirect, the customize Continue click, never
  // fired and missed direct-to-checkout paths.)
  "checkout_view",
  "order_placed",
] as const;

type FunnelStep = (typeof FUNNEL_STEPS)[number];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const start = url.searchParams.get("start") || defaultStart();
  const end = url.searchParams.get("end") || defaultEnd();
  // Date boundaries interpreted in Central time, matching the rest
  // of the analytics dashboards (ROAS, MRR). Avoids the "events
  // before midnight CT show up in tomorrow's bucket" footgun.
  const startIso = centralBoundary(start, false);
  const endIso = centralBoundary(end, true);

  // ── Funnel: distinct sessions per step ──────────────────────────
  // One row per (event_type, session_id) — group + count distinct
  // sessions client-side. With current volumes that's fine; if we
  // grow into millions of events we'd push this into a SQL view or
  // materialized rollup.
  const { data: stepRows } = await admin
    .from("storefront_events")
    .select("event_type, session_id")
    .eq("workspace_id", workspaceId)
    .in("event_type", FUNNEL_STEPS as readonly string[])
    .gte("created_at", startIso)
    .lte("created_at", endIso);

  const sessionsByStep: Record<FunnelStep, Set<string>> = {
    pdp_view: new Set(), pdp_engaged: new Set(), pack_selected: new Set(),
    customize_view: new Set(), checkout_view: new Set(), order_placed: new Set(),
  };
  for (const row of (stepRows || []) as { event_type: string; session_id: string }[]) {
    const k = row.event_type as FunnelStep;
    if (k in sessionsByStep) sessionsByStep[k].add(row.session_id);
  }

  const funnel = FUNNEL_STEPS.map((step, i) => {
    const count = sessionsByStep[step].size;
    const prev = i > 0 ? sessionsByStep[FUNNEL_STEPS[i - 1]].size : count;
    const topOfFunnel = sessionsByStep.pdp_view.size;
    return {
      step,
      sessions: count,
      conv_from_prev_pct: prev > 0 ? Math.round((count / prev) * 100 * 10) / 10 : 0,
      conv_from_top_pct: topOfFunnel > 0 ? Math.round((count / topOfFunnel) * 100 * 10) / 10 : 0,
      drop_from_prev: Math.max(0, prev - count),
    };
  });

  // ── Top products (by pack_selected) ─────────────────────────────
  const { data: pickedRows } = await admin
    .from("storefront_events")
    .select("product_id")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "pack_selected")
    .not("product_id", "is", null)
    .gte("created_at", startIso)
    .lte("created_at", endIso);
  const productCounts = new Map<string, number>();
  for (const r of (pickedRows || []) as { product_id: string }[]) {
    productCounts.set(r.product_id, (productCounts.get(r.product_id) || 0) + 1);
  }
  const topProductIds = [...productCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
  const { data: productRows } = topProductIds.length
    ? await admin.from("products").select("id, title, handle").in("id", topProductIds)
    : { data: [] };
  const productMap = new Map((productRows || []).map(p => [p.id, p]));
  const topProducts = topProductIds.map(id => ({
    product_id: id,
    title: productMap.get(id)?.title || "(unknown)",
    handle: productMap.get(id)?.handle || null,
    pack_selected_count: productCounts.get(id) || 0,
  }));

  // ── Sessions in window: device + country + utm_source ───────────
  // We aggregate over storefront_sessions whose last_seen_at falls in
  // the window. Acceptable approximation; perfectly accurate
  // attribution would require per-event joins which we can add later.
  const { data: sessionRows } = await admin
    .from("storefront_sessions")
    .select("id, device_type, ip_country, utm_source")
    .eq("workspace_id", workspaceId)
    .gte("last_seen_at", startIso)
    .lte("last_seen_at", endIso);

  const deviceCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const s of (sessionRows || []) as { device_type: string | null; ip_country: string | null; utm_source: string | null }[]) {
    const d = s.device_type || "unknown";
    deviceCounts.set(d, (deviceCounts.get(d) || 0) + 1);
    const c = s.ip_country || "unknown";
    countryCounts.set(c, (countryCounts.get(c) || 0) + 1);
    const u = s.utm_source || "(direct)";
    sourceCounts.set(u, (sourceCounts.get(u) || 0) + 1);
  }

  const deviceBreakdown = [...deviceCounts.entries()]
    .map(([device_type, count]) => ({ device_type, sessions: count }))
    .sort((a, b) => b.sessions - a.sessions);
  const countryBreakdown = [...countryCounts.entries()]
    .map(([ip_country, count]) => ({ ip_country, sessions: count }))
    .sort((a, b) => b.sessions - a.sessions).slice(0, 10);
  const sourceBreakdown = [...sourceCounts.entries()]
    .map(([utm_source, count]) => ({ utm_source, sessions: count }))
    .sort((a, b) => b.sessions - a.sessions).slice(0, 10);

  // ── Chapter performance (Phase 2 instrumentation) ───────────────
  // Per chapter: reach (distinct sessions that genuinely viewed it),
  // median-ish avg dwell, and the key effectiveness metric — of the
  // sessions that viewed a chapter, how many then clicked a
  // scroll-to-price CTA *from that chapter* (cta_click kind, origin
  // chapter). High view→scroll-to-price = the chapter sells.
  const { data: chapterRows } = await admin
    .from("storefront_events")
    .select("event_type, session_id, meta")
    .eq("workspace_id", workspaceId)
    .in("event_type", ["chapter_view", "chapter_dwell", "cta_click"])
    .gte("created_at", startIso)
    .lte("created_at", endIso);

  const viewSessions = new Map<string, Set<string>>(); // chapter → sessions
  const dwellTotals = new Map<string, { ms: number; n: number }>();
  const ctaSessions = new Map<string, Set<string>>(); // chapter → sessions w/ scroll_to_price click
  const chapterOrder = new Map<string, number>();
  for (const r of (chapterRows || []) as { event_type: string; session_id: string; meta: Record<string, unknown> }[]) {
    const m = r.meta || {};
    const chapter = typeof m.chapter === "string" ? m.chapter : null;
    if (!chapter) continue;
    if (typeof m.chapter_index === "number" && !chapterOrder.has(chapter)) {
      chapterOrder.set(chapter, m.chapter_index);
    }
    if (r.event_type === "chapter_view") {
      if (!viewSessions.has(chapter)) viewSessions.set(chapter, new Set());
      viewSessions.get(chapter)!.add(r.session_id);
    } else if (r.event_type === "chapter_dwell") {
      const ms = typeof m.dwell_ms === "number" ? m.dwell_ms : 0;
      const cur = dwellTotals.get(chapter) || { ms: 0, n: 0 };
      cur.ms += ms; cur.n += 1;
      dwellTotals.set(chapter, cur);
    } else if (r.event_type === "cta_click" && m.cta_kind === "scroll_to_price") {
      if (!ctaSessions.has(chapter)) ctaSessions.set(chapter, new Set());
      ctaSessions.get(chapter)!.add(r.session_id);
    }
  }
  const topOfFunnelSessions = sessionsByStep.pdp_view.size;
  const chapterKeys = new Set<string>([...viewSessions.keys(), ...dwellTotals.keys(), ...ctaSessions.keys()]);
  const chapterPerformance = [...chapterKeys]
    .map((chapter) => {
      const reach = viewSessions.get(chapter)?.size || 0;
      const dwell = dwellTotals.get(chapter);
      const ctaReach = ctaSessions.get(chapter)?.size || 0;
      return {
        chapter,
        chapter_index: chapterOrder.get(chapter) ?? 999,
        reach_sessions: reach,
        reach_rate_pct: topOfFunnelSessions > 0 ? Math.round((reach / topOfFunnelSessions) * 100 * 10) / 10 : 0,
        avg_dwell_ms: dwell && dwell.n > 0 ? Math.round(dwell.ms / dwell.n) : 0,
        scroll_to_price_sessions: ctaReach,
        // The effectiveness metric: of those who viewed this chapter, how
        // many clicked through to pricing from it.
        view_to_cta_pct: reach > 0 ? Math.round((ctaReach / reach) * 100 * 10) / 10 : 0,
      };
    })
    .sort((a, b) => a.chapter_index - b.chapter_index);

  // ── Recent events stream ────────────────────────────────────────
  const { data: recent } = await admin
    .from("storefront_events")
    .select("id, event_type, anonymous_id, product_id, meta, url, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(30);

  // ── Abandoned cart panel ────────────────────────────────────────
  // Within the same date window (against cart_drafts.created_at):
  //   - emailed: count where abandoned_email_sent_at IS NOT NULL
  //   - recovered: emailed AND status='converted' AND converted after email
  //   - open_now: status='open' AND email NOT NULL — eligible pool
  //   - revenue_recovered: sum total_cents of converted+emailed drafts
  // Recovery rate = recovered / emailed.
  const { data: cartRows } = await admin
    .from("cart_drafts")
    .select("id, email, status, line_items, total_cents, subtotal_cents, abandoned_email_sent_at, converted_order_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", startIso)
    .lte("created_at", endIso);

  let emailed = 0;
  let recovered = 0;
  let revenueRecoveredCents = 0;
  let openWithEmail = 0;
  const recentAbandoned: Array<{
    id: string;
    email: string;
    item_count: number;
    subtotal_cents: number;
    status: string;
    abandoned_email_sent_at: string | null;
    converted_order_id: string | null;
    created_at: string;
  }> = [];

  for (const c of (cartRows || []) as Array<{
    id: string;
    email: string | null;
    status: string;
    line_items: unknown[];
    total_cents: number;
    subtotal_cents: number;
    abandoned_email_sent_at: string | null;
    converted_order_id: string | null;
    created_at: string;
    updated_at: string;
  }>) {
    if (c.abandoned_email_sent_at) {
      emailed++;
      if (c.status === "converted") {
        recovered++;
        revenueRecoveredCents += c.total_cents || 0;
      }
    }
    if (c.status === "open" && c.email) {
      openWithEmail++;
    }
  }

  // Recent abandoned carts (had email + idle 30+min OR already emailed),
  // newest first. Drives the table on the dashboard panel.
  const cutoffIso = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentAbandonedRows } = await admin
    .from("cart_drafts")
    .select("id, email, status, line_items, subtotal_cents, abandoned_email_sent_at, converted_order_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .not("email", "is", null)
    .or(`abandoned_email_sent_at.not.is.null,and(status.eq.open,updated_at.lte.${cutoffIso})`)
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("updated_at", { ascending: false })
    .limit(25);

  for (const c of (recentAbandonedRows || []) as Array<{
    id: string;
    email: string;
    status: string;
    line_items: unknown[];
    subtotal_cents: number;
    abandoned_email_sent_at: string | null;
    converted_order_id: string | null;
    created_at: string;
  }>) {
    recentAbandoned.push({
      id: c.id,
      email: c.email,
      item_count: Array.isArray(c.line_items) ? c.line_items.length : 0,
      subtotal_cents: c.subtotal_cents,
      status: c.status,
      abandoned_email_sent_at: c.abandoned_email_sent_at,
      converted_order_id: c.converted_order_id,
      created_at: c.created_at,
    });
  }

  const abandonedCarts = {
    emailed,
    recovered,
    revenue_recovered_cents: revenueRecoveredCents,
    open_with_email: openWithEmail,
    recovery_rate_pct: emailed > 0 ? Math.round((recovered / emailed) * 100 * 10) / 10 : 0,
    recent: recentAbandoned,
  };

  return NextResponse.json({
    range: { start, end },
    total_sessions: (sessionRows || []).length,
    funnel,
    topProducts,
    deviceBreakdown,
    countryBreakdown,
    sourceBreakdown,
    chapterPerformance,
    abandonedCarts,
    recentEvents: (recent || []).map(e => ({
      id: e.id,
      event_type: e.event_type,
      anonymous_id: e.anonymous_id,
      product_id: e.product_id,
      meta: e.meta,
      url: e.url,
      created_at: e.created_at,
    })),
  });
}

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function defaultStart(): string {
  // 7-day window ending today (Central). Use noon UTC for the
  // n-days-ago math so the resulting Central date is unambiguous
  // (noon UTC = morning Central, comfortably away from midnight).
  const today = todayCentral();
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d - 6, 12));
  return noon.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function defaultEnd(): string {
  return todayCentral();
}

/**
 * Convert a YYYY-MM-DD Central-time date into the UTC ISO instant
 * for either start-of-day (00:00:00.000 CT) or end-of-day
 * (23:59:59.999 CT). DST-aware via Intl.DateTimeFormat — we query
 * the actual Central offset for noon UTC on the target date.
 */
function centralBoundary(yyyyMmDd: string, endOfDay: boolean): string {
  const time = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";

  // Resolve Central's offset for this calendar day. Noon UTC is a
  // safe pick — it falls in the middle of the day regardless of DST.
  const noon = new Date(`${yyyyMmDd}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    timeZoneName: "longOffset",
  });
  const parts = fmt.formatToParts(noon);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
  const match = tzName.match(/GMT([+-])(\d\d):(\d\d)/);
  let offsetMinutes = 0;
  if (match) {
    const sign = match[1] === "+" ? 1 : -1;
    offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
  }

  // The string "{yyyyMmDd}T00:00:00.000Z" treated as a UTC moment
  // represents Central wall time numerically. Shift by -offsetMinutes
  // to get the actual UTC instant of that wall time.
  const wallAsUtc = new Date(`${yyyyMmDd}${time}`);
  return new Date(wallAsUtc.getTime() - offsetMinutes * 60_000).toISOString();
}
