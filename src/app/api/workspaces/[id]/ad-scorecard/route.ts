/**
 * Ad & Lander Quality Scorecard. Spec: docs/brain/specs/ad-lander-scorecard.md.
 *
 * Groups REAL storefront sessions (internal/bot excluded, same rule as the
 * funnel) by two lenses and scores traffic quality, not just volume:
 *
 *   - Ad creative  → utm_campaign (= ad_campaigns.name) + utm_content (Meta ad id)
 *   - Lander       → variant/angle parsed from landing_url
 *
 * Per group: PDP visitors (cohort), engaged rate, add-to-cart rate, lead rate,
 * checkout rate, purchases + revenue, CVR.
 *
 * Attribution model (deliberate — see spec § Attribution model):
 *   - Engagement / intent / leads are PER-SESSION, on the session's own
 *     utm_campaign / landing variant (the traffic the ad sent / lander shown).
 *   - Ad-creative purchases + revenue come from `orders.attributed_utm_campaign`
 *     (FIRST-TOUCH) so cross-session / coupon-return sales aren't undercounted.
 *   - Lander purchases + revenue are SESSION-SCOPED (order_placed event +
 *     meta.total_cents) because orders don't persist the lander variant.
 *
 * Date range is interpreted in Central time, matching the funnel + ROAS/MRR
 * dashboards. Cohort = sessions that fired pdp_view in the window (the visitors
 * the ad actually sent to a product page).
 */

import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Page past PostgREST's 1000-row cap. makeQuery must return a fresh builder
// each call and carry a deterministic .order() (range paging needs a stable
// sort). Mirrors the funnel route's helper.
async function fetchAllRows<T>(makeQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> }): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) break;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// Per-session engagement/intent flags, accumulated from in-window events.
interface SessionAgg {
  engaged: boolean;
  add_to_cart: boolean;
  pack_selected: boolean;
  checkout_view: boolean;
  order_placed: boolean;
  order_revenue_cents: number; // from order_placed meta.total_cents (session-scoped)
}

type SortableMetrics = {
  sessions: number;
  engaged: number;
  engaged_rate_pct: number;
  add_to_cart: number;
  atc_rate_pct: number;
  checkout: number;
  leads: number;
  lead_rate_pct: number;
  purchases: number;
  revenue_cents: number;
  cvr_pct: number;
};

function rate(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100 * 10) / 10 : 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const minSessions = Math.max(1, Number(url.searchParams.get("min") || "1") || 1);

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Launch floor — never count pre-launch testing/crawler traffic.
  const { data: ws } = await admin
    .from("workspaces").select("storefront_launch_at")
    .eq("id", workspaceId).maybeSingle();

  let start = url.searchParams.get("start") || defaultStart();
  const end = url.searchParams.get("end") || defaultEnd();
  const launchAt = (ws?.storefront_launch_at as string | null) || null;
  if (launchAt) {
    const launchDate = new Date(launchAt).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    if (start < launchDate) start = launchDate;
  }
  const startIso = centralBoundary(start, false);
  const endIso = centralBoundary(end, true);

  // ── Non-real-traffic exclusion (same set as the funnel) ─────────
  const { data: internalCustomerRows } = await admin
    .from("customers").select("id")
    .eq("workspace_id", workspaceId).eq("is_internal", true);
  const internalCustomerIds = (internalCustomerRows || []).map((c) => c.id as string);
  const internalCustomerSet = new Set(internalCustomerIds);

  const orClauses = ["is_internal.eq.true", "is_bot.eq.true"];
  if (internalCustomerIds.length > 0) orClauses.push(`customer_id.in.(${internalCustomerIds.join(",")})`);
  const { data: internalSessionRows } = await admin
    .from("storefront_sessions").select("id")
    .eq("workspace_id", workspaceId)
    .or(orClauses.join(","));
  const internalSessions = new Set((internalSessionRows || []).map((s) => s.id as string));

  // ── Per-session flags from in-window events ─────────────────────
  // Cohort = sessions that fired pdp_view in the window (the visitors an ad
  // actually delivered to a PDP — the denominator for every rate).
  const eventRows = await fetchAllRows<{ event_type: string; session_id: string; meta: Record<string, unknown> | null }>(() =>
    admin
      .from("storefront_events")
      .select("event_type, session_id, meta")
      .eq("workspace_id", workspaceId)
      .in("event_type", ["pdp_view", "pdp_engaged", "add_to_cart", "pack_selected", "checkout_view", "order_placed"])
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("id", { ascending: true }),
  );

  const agg = new Map<string, SessionAgg>();
  const cohort = new Set<string>(); // sessions with pdp_view
  const ensure = (sid: string): SessionAgg => {
    let a = agg.get(sid);
    if (!a) { a = { engaged: false, add_to_cart: false, pack_selected: false, checkout_view: false, order_placed: false, order_revenue_cents: 0 }; agg.set(sid, a); }
    return a;
  };
  for (const r of eventRows) {
    if (internalSessions.has(r.session_id)) continue;
    const a = ensure(r.session_id);
    switch (r.event_type) {
      case "pdp_view": cohort.add(r.session_id); break;
      case "pdp_engaged": a.engaged = true; break;
      case "add_to_cart": a.add_to_cart = true; break;
      case "pack_selected": a.pack_selected = true; break;
      case "checkout_view": a.checkout_view = true; break;
      case "order_placed": {
        a.order_placed = true;
        const tc = r.meta && typeof r.meta.total_cents === "number" ? r.meta.total_cents : 0;
        a.order_revenue_cents += tc;
        break;
      }
    }
  }
  // A converting session may have fired order_placed but not a pdp_view in the
  // window (direct-to-checkout / coupon link). Keep those in the cohort so the
  // sale is attributed to its session's creative/lander.
  for (const [sid, a] of agg) { if (a.order_placed) cohort.add(sid); }

  // ── Session identity: utm_campaign / utm_content / landing variant ──
  const cohortIds = [...cohort];
  const sessionMeta = new Map<string, { utm_campaign: string | null; utm_content: string | null; utm_source: string | null; landing_url: string | null }>();
  for (let i = 0; i < cohortIds.length; i += 300) {
    const chunk = cohortIds.slice(i, i + 300);
    const { data } = await admin
      .from("storefront_sessions")
      .select("id, utm_campaign, utm_content, utm_source, landing_url")
      .in("id", chunk);
    for (const s of (data || []) as { id: string; utm_campaign: string | null; utm_content: string | null; utm_source: string | null; landing_url: string | null }[]) {
      sessionMeta.set(s.id, { utm_campaign: s.utm_campaign, utm_content: s.utm_content, utm_source: s.utm_source, landing_url: s.landing_url });
    }
  }

  // ── Leads per session (popup + survey signups) ──────────────────
  const { data: leadRows } = await admin
    .from("storefront_leads")
    .select("session_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", startIso)
    .lte("created_at", endIso);
  const leadSessions = new Set<string>();
  for (const r of (leadRows || []) as { session_id: string | null }[]) {
    if (r.session_id && !internalSessions.has(r.session_id)) leadSessions.add(r.session_id);
  }

  // ── First-touch orders, grouped by attributed_utm_campaign ──────
  // The ad-creative lens's purchases + revenue (excludes internal customers).
  const orderRows = await fetchAllRows<{ attributed_utm_campaign: string | null; attributed_utm_content: string | null; total_cents: number | null; customer_id: string | null }>(() =>
    admin
      .from("orders")
      .select("attributed_utm_campaign, attributed_utm_content, total_cents, customer_id, id")
      .eq("workspace_id", workspaceId)
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("id", { ascending: true }),
  );
  const ordersByCampaign = new Map<string, { orders: number; revenue_cents: number; ad_id: string | null }>();
  for (const o of orderRows) {
    if (o.customer_id && internalCustomerSet.has(o.customer_id)) continue;
    if (!o.attributed_utm_campaign) continue;
    const key = decode(o.attributed_utm_campaign);
    const cur = ordersByCampaign.get(key) || { orders: 0, revenue_cents: 0, ad_id: o.attributed_utm_content };
    cur.orders += 1;
    cur.revenue_cents += Number(o.total_cents || 0);
    if (!cur.ad_id && o.attributed_utm_content) cur.ad_id = o.attributed_utm_content;
    ordersByCampaign.set(key, cur);
  }

  // ── Group cohort sessions → ad creative + lander ────────────────
  interface CreativeBucket { sessions: Set<string>; engaged: number; atc: number; pack: number; checkout: number; leads: number; sessionOrders: number; adIds: Map<string, number>; sources: Set<string>; }
  interface LanderBucket { sessions: Set<string>; engaged: number; atc: number; pack: number; checkout: number; leads: number; purchases: number; revenue_cents: number; variant: string; angle: string | null; path: string | null; }
  const creatives = new Map<string, CreativeBucket>();
  const landers = new Map<string, LanderBucket>();

  for (const sid of cohort) {
    const m = sessionMeta.get(sid);
    const a = agg.get(sid) || { engaged: false, add_to_cart: false, pack_selected: false, checkout_view: false, order_placed: false, order_revenue_cents: 0 };
    const isLead = leadSessions.has(sid);

    // Ad creative lens.
    const campaign = m?.utm_campaign ? decode(m.utm_campaign) : "(no utm_campaign)";
    let cb = creatives.get(campaign);
    if (!cb) { cb = { sessions: new Set(), engaged: 0, atc: 0, pack: 0, checkout: 0, leads: 0, sessionOrders: 0, adIds: new Map(), sources: new Set() }; creatives.set(campaign, cb); }
    cb.sessions.add(sid);
    if (a.engaged) cb.engaged++;
    if (a.add_to_cart) cb.atc++;
    if (a.pack_selected) cb.pack++;
    if (a.checkout_view) cb.checkout++;
    if (isLead) cb.leads++;
    if (a.order_placed) cb.sessionOrders++;
    if (m?.utm_content) cb.adIds.set(m.utm_content, (cb.adIds.get(m.utm_content) || 0) + 1);
    if (m?.utm_source) cb.sources.add(m.utm_source);

    // Lander lens.
    const parsed = parseLander(m?.landing_url || null);
    const landerKey = `${parsed.variant}::${parsed.angle || ""}`;
    let lb = landers.get(landerKey);
    if (!lb) { lb = { sessions: new Set(), engaged: 0, atc: 0, pack: 0, checkout: 0, leads: 0, purchases: 0, revenue_cents: 0, variant: parsed.variant, angle: parsed.angle, path: parsed.path }; landers.set(landerKey, lb); }
    lb.sessions.add(sid);
    if (a.engaged) lb.engaged++;
    if (a.add_to_cart) lb.atc++;
    if (a.pack_selected) lb.pack++;
    if (a.checkout_view) lb.checkout++;
    if (isLead) lb.leads++;
    if (a.order_placed) { lb.purchases++; lb.revenue_cents += a.order_revenue_cents; }
  }

  // ── Enrichment: which creatives are ShopCX-published ad_campaigns ──
  // A utm_campaign that matches an ad_campaigns row is a creative we published
  // through the ad tool (one ad in Meta); anything else was set up directly in
  // Meta Ads Manager and its utm_campaign is whatever was named there.
  const { data: campMetaRows } = await admin
    .from("ad_campaigns").select("name")
    .eq("workspace_id", workspaceId);
  const knownCreatives = new Set<string>();
  for (const c of (campMetaRows || []) as { name: string | null }[]) {
    if (c.name) knownCreatives.add(decode(c.name));
  }
  const { data: advRows } = await admin
    .from("advertorial_pages").select("slug, variant, publication, headline")
    .eq("workspace_id", workspaceId);
  const advBySlug = new Map<string, { publication: string | null; headline: string | null; variant: string | null }>();
  for (const p of (advRows || []) as { slug: string | null; variant: string | null; publication: string | null; headline: string | null }[]) {
    if (p.slug) advBySlug.set(p.slug, { publication: p.publication, headline: p.headline, variant: p.variant });
  }

  // ── Assemble ad-creative rows ───────────────────────────────────
  const adRows = [...creatives.entries()].map(([campaign, b]) => {
    const sessions = b.sessions.size;
    const fromOrders = ordersByCampaign.get(campaign);
    const purchases = fromOrders?.orders ?? b.sessionOrders;
    const revenue_cents = fromOrders?.revenue_cents ?? 0;
    // Dominant Meta ad id seen on this creative's sessions (fallback: orders').
    let topAdId: string | null = fromOrders?.ad_id ?? null;
    let topN = 0;
    for (const [id, n] of b.adIds) if (n > topN) { topN = n; topAdId = id; }
    const metrics: SortableMetrics = {
      sessions,
      engaged: b.engaged,
      engaged_rate_pct: rate(b.engaged, sessions),
      add_to_cart: b.atc,
      atc_rate_pct: rate(b.atc, sessions),
      checkout: b.checkout,
      leads: b.leads,
      lead_rate_pct: rate(b.leads, sessions),
      purchases,
      revenue_cents,
      cvr_pct: rate(purchases, sessions),
    };
    return {
      campaign,
      meta_ad_id: topAdId,
      sources: [...b.sources],
      known_creative: knownCreatives.has(campaign),
      meets_min_volume: sessions >= minSessions,
      ...metrics,
      quality_score: qualityScore(metrics),
    };
  }).sort((a, b) => b.sessions - a.sessions);

  // ── Assemble lander rows ────────────────────────────────────────
  const landerRows = [...landers.values()].map((b) => {
    const sessions = b.sessions.size;
    const adv = b.angle ? advBySlug.get(b.angle) : undefined;
    const metrics: SortableMetrics = {
      sessions,
      engaged: b.engaged,
      engaged_rate_pct: rate(b.engaged, sessions),
      add_to_cart: b.atc,
      atc_rate_pct: rate(b.atc, sessions),
      checkout: b.checkout,
      leads: b.leads,
      lead_rate_pct: rate(b.leads, sessions),
      purchases: b.purchases,
      revenue_cents: b.revenue_cents,
      cvr_pct: rate(b.purchases, sessions),
    };
    return {
      variant: b.variant,
      angle: b.angle,
      path: b.path,
      publication: adv?.publication ?? null,
      headline: adv?.headline ?? null,
      meets_min_volume: sessions >= minSessions,
      ...metrics,
      quality_score: qualityScore(metrics),
    };
  }).sort((a, b) => b.sessions - a.sessions);

  return NextResponse.json({
    range: { start, end },
    min_sessions: minSessions,
    cohort_sessions: cohort.size,
    ads: adRows,
    landers: landerRows,
    notes: {
      attribution: "Engagement/ATC/leads per-session; ad purchases first-touch (orders.attributed_utm_campaign); lander purchases session-scoped (order_placed). Internal/bot excluded.",
    },
  });
}

/** A single 0–100 traffic-quality score: weighted blend of the rates that
 *  matter for a paid visitor, so creatives/landers sort by *value*, not volume.
 *  Weights favour the bottom of the funnel (purchase > ATC > engaged). */
function qualityScore(m: SortableMetrics): number {
  const s = m.cvr_pct * 6 + m.atc_rate_pct * 2 + m.lead_rate_pct * 1.5 + m.engaged_rate_pct * 0.4;
  return Math.round(s * 10) / 10;
}

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Parse the lander variant + angle from a stored landing_url. Meta ads send
 *  `?variant=advertorial&angle=callout-74820d61` etc.; a bare PDP has neither. */
function parseLander(landingUrl: string | null): { variant: string; angle: string | null; path: string | null } {
  if (!landingUrl) return { variant: "(unknown)", angle: null, path: null };
  try {
    const u = new URL(landingUrl);
    const variant = u.searchParams.get("variant");
    const angle = u.searchParams.get("angle");
    return { variant: variant || "(default PDP)", angle: angle || null, path: u.pathname };
  } catch {
    return { variant: "(unknown)", angle: null, path: null };
  }
}

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function defaultStart(): string {
  const today = todayCentral();
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d - 6, 12));
  return noon.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function defaultEnd(): string {
  return todayCentral();
}

/** YYYY-MM-DD Central date → UTC ISO instant for start/end of that day,
 *  DST-aware. Identical to the funnel route's boundary helper. */
function centralBoundary(yyyyMmDd: string, endOfDay: boolean): string {
  const time = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const noon = new Date(`${yyyyMmDd}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" });
  const parts = fmt.formatToParts(noon);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
  const match = tzName.match(/GMT([+-])(\d\d):(\d\d)/);
  let offsetMinutes = 0;
  if (match) {
    const sign = match[1] === "+" ? 1 : -1;
    offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
  }
  const wallAsUtc = new Date(`${yyyyMmDd}${time}`);
  return new Date(wallAsUtc.getTime() - offsetMinutes * 60_000).toISOString();
}
