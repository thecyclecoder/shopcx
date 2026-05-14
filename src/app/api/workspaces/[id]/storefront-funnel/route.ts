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
  "checkout_redirect",
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
  const startIso = new Date(`${start}T00:00:00Z`).toISOString();
  const endIso = new Date(`${end}T23:59:59.999Z`).toISOString();

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
    customize_view: new Set(), checkout_redirect: new Set(), order_placed: new Set(),
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

  // ── Recent events stream ────────────────────────────────────────
  const { data: recent } = await admin
    .from("storefront_events")
    .select("id, event_type, anonymous_id, product_id, meta, url, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(30);

  return NextResponse.json({
    range: { start, end },
    total_sessions: (sessionRows || []).length,
    funnel,
    topProducts,
    deviceBreakdown,
    countryBreakdown,
    sourceBreakdown,
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

function defaultStart(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
}
function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}
