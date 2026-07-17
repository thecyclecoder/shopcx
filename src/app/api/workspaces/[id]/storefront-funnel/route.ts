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
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { winProbabilityVsControl } from "@/lib/storefront/bandit";
import { getLeverImportancePanel } from "@/lib/storefront/lever-memory";

const FUNNEL_STEPS = [
  "pdp_view",
  "pdp_engaged",
  // Selecting a pack navigates straight to /customize, so pack_selected and
  // customize_view are the same moment — we keep pack_selected (the explicit
  // selection action, which also powers the top-products breakdown) as the
  // single step and drop customize_view to avoid a redundant funnel row.
  "pack_selected",
  // The checkout page fires checkout_view on load — the reliable "reached
  // checkout" signal. (checkout_redirect, the customize Continue click, never
  // fired and missed direct-to-checkout paths.)
  "checkout_view",
  "order_placed",
] as const;

type FunnelStep = (typeof FUNNEL_STEPS)[number];

/**
 * Page past PostgREST's `max-rows` cap (1000 on this instance). An unbounded
 * `.select()` silently returns only the first 1000 rows — which was undercounting
 * every funnel step once a window held >1000 events. `makeQuery` must return a
 * FRESH builder each call (Supabase builders are single-use once awaited) AND
 * carry a deterministic `.order()` — range paging overlaps/skips rows without a
 * stable total sort.
 */
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  // Optional product scope: with product_id on checkout_view/order_placed now
  // carried, the whole funnel can resolve per product (advertorial-lander A/B).
  const productScope = url.searchParams.get("product_id");

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Launch floor: the funnel never counts data before the storefront went
  // live (pre-launch = testing + ad-review crawlers, never real customers).
  const { data: ws } = await admin
    .from("workspaces").select("storefront_launch_at")
    .eq("id", workspaceId).maybeSingle();

  let start = url.searchParams.get("start") || defaultStart();
  const end = url.searchParams.get("end") || defaultEnd();
  const launchAt = (ws?.storefront_launch_at as string | null) || null;
  if (launchAt) {
    const launchDate = new Date(launchAt).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    if (start < launchDate) start = launchDate; // clamp display + ISO boundary below
  }
  // Date boundaries interpreted in Central time, matching the rest
  // of the analytics dashboards (ROAS, MRR). Avoids the "events
  // before midnight CT show up in tomorrow's bucket" footgun.
  const startIso = centralBoundary(start, false);
  const endIso = centralBoundary(end, true);

  // ── Non-real-traffic exclusion ──────────────────────────────────
  // Drop a session (and its events) from every metric when it's:
  //   - is_internal  — team/testing device (sx_internal cookie), OR
  //   - is_bot       — datacenter/crawler IP (Meta ad-review bots), OR
  //   - stitched to an internal customer (customers.is_internal).
  // So the funnel reflects real shoppers only.
  const { data: internalCustomerRows } = await admin
    .from("customers").select("id")
    .eq("workspace_id", workspaceId).eq("is_internal", true);
  const internalCustomerIds = (internalCustomerRows || []).map((c) => c.id as string);

  const orClauses = ["is_internal.eq.true", "is_bot.eq.true"];
  if (internalCustomerIds.length > 0) orClauses.push(`customer_id.in.(${internalCustomerIds.join(",")})`);
  const { data: internalSessionRows } = await admin
    .from("storefront_sessions").select("id")
    .eq("workspace_id", workspaceId)
    .or(orClauses.join(","));
  // Name kept generic — this is the full "exclude from funnel" set.
  const internalSessions = new Set((internalSessionRows || []).map((s) => s.id as string));

  // ── Funnel: distinct sessions per step ──────────────────────────
  // Paginated (fetchAllRows) so we count ALL events, not the first 1000.
  // We also pull add_to_cart in the same sweep (same moment as pack_selected,
  // but surfaced as its own "Add to cart" metric).
  const STEP_FETCH = [...FUNNEL_STEPS, "add_to_cart"];
  const stepRows = await fetchAllRows<{ event_type: string; session_id: string }>(() => {
    let q = admin
      .from("storefront_events")
      .select("event_type, session_id")
      .eq("workspace_id", workspaceId)
      .in("event_type", STEP_FETCH)
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("id", { ascending: true });
    if (productScope) q = q.eq("product_id", productScope);
    return q;
  });

  const sessionsByStep: Record<FunnelStep, Set<string>> = {
    pdp_view: new Set(), pdp_engaged: new Set(), pack_selected: new Set(),
    checkout_view: new Set(), order_placed: new Set(),
  };
  const atcSessions = new Set<string>();
  for (const row of stepRows) {
    if (internalSessions.has(row.session_id)) continue;
    if (row.event_type === "add_to_cart") { atcSessions.add(row.session_id); continue; }
    const k = row.event_type as FunnelStep;
    if (k in sessionsByStep) sessionsByStep[k].add(row.session_id);
  }
  const addToCart = atcSessions.size;

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

  // ── Leads generated (popup marketing signups) ───────────────────
  // A parallel conversion, not a linear funnel step — someone can become a
  // lead without buying, and buyers don't have to be leads. Count distinct
  // real sessions that fired lead_captured in the window.
  const { data: leadRows } = await admin
    .from("storefront_events")
    .select("session_id")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "lead_captured")
    .gte("created_at", startIso)
    .lte("created_at", endIso);
  const leadSessions = new Set<string>();
  for (const r of (leadRows || []) as { session_id: string }[]) {
    if (!internalSessions.has(r.session_id)) leadSessions.add(r.session_id);
  }
  const leadsGenerated = leadSessions.size;

  // ── Top products + pack-size breakdown (by pack_selected) ───────
  const { data: pickedRows } = await admin
    .from("storefront_events")
    .select("product_id, session_id, meta")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "pack_selected")
    .not("product_id", "is", null)
    .gte("created_at", startIso)
    .lte("created_at", endIso);
  const productCounts = new Map<string, number>();
  // Which pack the customer chose: single 1/2/3-pack, or coffee+creamer
  // bundle 1×1 / 2×2. Single-tier events captured the quantity only after the
  // instrumentation fix, so older ones land in "Single (qty n/a)".
  const PACK_ORDER = ["1-pack", "2-pack", "3-pack", "Single (qty n/a)", "Bundle 1×1", "Bundle 2×2", "Bundle"];
  const packCounts = new Map<string, number>();
  for (const r of (pickedRows || []) as { product_id: string; session_id: string; meta: Record<string, unknown> }[]) {
    if (internalSessions.has(r.session_id)) continue;
    productCounts.set(r.product_id, (productCounts.get(r.product_id) || 0) + 1);
    const m = r.meta || {};
    let label: string;
    if (m.bundle) {
      const bs = typeof m.bundle_size === "number" ? m.bundle_size : null;
      label = bs ? `Bundle ${bs}×${bs}` : "Bundle";
    } else {
      const q = typeof m.quantity === "number" ? m.quantity : null;
      label = q ? `${q}-pack` : "Single (qty n/a)";
    }
    packCounts.set(label, (packCounts.get(label) || 0) + 1);
  }
  const packBreakdown = [...packCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => {
      const ai = PACK_ORDER.indexOf(a.label), bi = PACK_ORDER.indexOf(b.label);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
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
  const sessionRows = await fetchAllRows<{ id: string; device_type: string | null; ip_country: string | null; utm_source: string | null }>(() =>
    admin
      .from("storefront_sessions")
      .select("id, device_type, ip_country, utm_source")
      .eq("workspace_id", workspaceId)
      .gte("last_seen_at", startIso)
      .lte("last_seen_at", endIso)
      .order("id", { ascending: true }),
  );

  const visibleSessions = (sessionRows || []).filter(
    (s) => !internalSessions.has((s as { id: string }).id),
  ) as { id: string; device_type: string | null; ip_country: string | null; utm_source: string | null }[];

  const deviceCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const s of visibleSessions) {
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
  const chapterRows = await fetchAllRows<{ event_type: string; session_id: string; meta: Record<string, unknown> }>(() =>
    admin
      .from("storefront_events")
      .select("event_type, session_id, meta")
      .eq("workspace_id", workspaceId)
      .in("event_type", ["chapter_view", "chapter_dwell", "cta_click"])
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("id", { ascending: true }),
  );

  const viewSessions = new Map<string, Set<string>>(); // chapter → sessions
  const dwellTotals = new Map<string, { ms: number; n: number }>();
  const ctaSessions = new Map<string, Set<string>>(); // chapter → sessions w/ scroll_to_price click
  const chapterOrder = new Map<string, number>();
  for (const r of (chapterRows || []) as { event_type: string; session_id: string; meta: Record<string, unknown> }[]) {
    if (internalSessions.has(r.session_id)) continue;
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
  // Over-fetch so that after dropping internal events we still have ~30.
  const { data: recentRaw } = await admin
    .from("storefront_events")
    .select("id, event_type, session_id, anonymous_id, product_id, meta, url, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(120);
  const recent = (recentRaw || [])
    .filter((e) => !internalSessions.has((e as { session_id: string }).session_id))
    .slice(0, 30);

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

  // ── Lead-capture popup funnel (shown → engaged → email → phone) ──
  // shown/engaged/converted come from popup_decisions (one row per session);
  // the email step (step 1) isn't a popup_decisions flag, so it's counted
  // from storefront_leads by source. variant: discount = offer, quiz = survey.
  const { data: popupDecisionRows } = await admin
    .from("popup_decisions")
    .select("variant, shown, engaged, converted, session_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", startIso)
    .lte("created_at", endIso);
  const { data: popupLeadRows } = await admin
    .from("storefront_leads")
    .select("source, email, phone, session_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", startIso)
    .lte("created_at", endIso);

  const popupVariants = [
    { variant: "discount", label: "Offer", shown: 0, engaged: 0, email: 0, phone: 0 },
    { variant: "quiz", label: "Survey", shown: 0, engaged: 0, email: 0, phone: 0 },
  ];
  const byVariant = new Map(popupVariants.map((v) => [v.variant, v]));
  for (const r of (popupDecisionRows || []) as { variant: string; shown: boolean; engaged: boolean; converted: boolean; session_id: string | null }[]) {
    if (r.session_id && internalSessions.has(r.session_id)) continue;
    const v = byVariant.get(r.variant);
    if (!v) continue; // skip "none" (suppressed)
    if (r.shown) v.shown++;
    if (r.engaged) v.engaged++;
    if (r.converted) v.phone++;
  }
  const sourceToVariant: Record<string, string> = { popup_discount: "discount", popup_quiz: "quiz" };
  for (const r of (popupLeadRows || []) as { source: string | null; email: string | null; session_id: string | null }[]) {
    if (r.session_id && internalSessions.has(r.session_id)) continue;
    if (!r.email) continue;
    const v = byVariant.get(sourceToVariant[r.source || ""] || "");
    if (v) v.email++;
  }
  const popupTotals = popupVariants.reduce(
    (acc, v) => ({ shown: acc.shown + v.shown, engaged: acc.engaged + v.engaged, email: acc.email + v.email, phone: acc.phone + v.phone }),
    { shown: 0, engaged: 0, email: 0, phone: 0 },
  );
  const popupFunnel = { byVariant: popupVariants, totals: popupTotals };

  // ── Survey chapter funnel (shown → completed → email → phone) ────
  // shown/completed = distinct real sessions firing the survey events;
  // email/phone = storefront_leads with source='survey_chapter'.
  const { data: surveyEventRows } = await admin
    .from("storefront_events")
    .select("event_type, session_id")
    .eq("workspace_id", workspaceId)
    .in("event_type", ["survey_shown", "survey_completed"])
    .gte("created_at", startIso)
    .lte("created_at", endIso);
  const surveyShownSessions = new Set<string>();
  const surveyCompletedSessions = new Set<string>();
  for (const r of (surveyEventRows || []) as { event_type: string; session_id: string }[]) {
    if (internalSessions.has(r.session_id)) continue;
    if (r.event_type === "survey_shown") surveyShownSessions.add(r.session_id);
    else if (r.event_type === "survey_completed") surveyCompletedSessions.add(r.session_id);
  }
  let surveyEmail = 0;
  let surveyPhone = 0;
  for (const r of (popupLeadRows || []) as { source: string | null; email: string | null; phone: string | null; session_id: string | null }[]) {
    if (r.session_id && internalSessions.has(r.session_id)) continue;
    if (r.source !== "survey_chapter") continue;
    if (r.email) surveyEmail++;
    if (r.phone) surveyPhone++;
  }
  const surveyFunnel = {
    shown: surveyShownSessions.size,
    completed: surveyCompletedSessions.size,
    email: surveyEmail,
    phone: surveyPhone,
  };

  // Running storefront experiments + their per-arm win-probability vs control
  // (Phase 4 surfacing). Best-effort — empty if the tables aren't present yet.
  const runningExperiments = await buildRunningExperiments(admin, workspaceId);

  // "What the agent believes matters" — the M2 lever-importance posteriors. Best-effort
  // (empty if the lever-memory tables aren't present yet).
  const leverImportance = await getLeverImportancePanel(admin, workspaceId);

  // Predicted-LTV-per-visitor week-over-week per (product × lander × audience) — the M3
  // reward the bandit optimizes. Best-effort (empty if storefront_ltv_metrics is absent).
  const predictedLtv = await buildPredictedLtv(admin, workspaceId);

  // The M5 Head-of-Growth campaign-grading report: every concluded campaign with its initial +
  // revised grade, hypothesis/result sub-scores, and the agent's average-grade trend. Best-effort
  // (empty if storefront_campaign_grades is absent).
  const campaignGrades = await buildCampaignGrades(admin, workspaceId);

  return NextResponse.json({
    range: { start, end },
    total_sessions: visibleSessions.length,
    add_to_cart: addToCart,
    leads_generated: leadsGenerated,
    popupFunnel,
    surveyFunnel,
    funnel,
    runningExperiments,
    leverImportance,
    predictedLtv,
    campaignGrades,
    packBreakdown,
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

interface ExperimentArm {
  variant_id: string;
  label: string;
  is_control: boolean;
  sessions: number;
  conversions: number;
  sub_attach: number;
  revenue_cents: number;
  win_prob: number | null;
}
export interface RunningExperiment {
  experiment_id: string;
  product_id: string;
  lever: string;
  lander_type: string;
  status: string;
  holdout_pct: number;
  arms: ExperimentArm[];
}

/** Active experiments + each non-control arm's posterior win-probability vs control. */
async function buildRunningExperiments(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<RunningExperiment[]> {
  try {
    const { data: experiments } = await admin
      .from("storefront_experiments")
      .select("id, product_id, lever, lander_type, status, holdout_pct, promoted_variant_id")
      .eq("workspace_id", workspaceId)
      .in("status", ["running", "promoted"]);
    if (!experiments?.length) return [];

    const { data: variants } = await admin
      .from("storefront_experiment_variants")
      .select("id, experiment_id, label, is_control, sessions, conversions, sub_attach, revenue_cents, alpha, beta")
      .in("experiment_id", experiments.map((e) => e.id));

    const byExperiment = new Map<string, typeof variants>();
    for (const v of variants || []) {
      const arr = byExperiment.get(v.experiment_id) || [];
      arr.push(v);
      byExperiment.set(v.experiment_id, arr);
    }

    const out: RunningExperiment[] = [];
    for (const e of experiments) {
      const vs = byExperiment.get(e.id) || [];
      const control = vs.find((v) => v.is_control);
      const arms: ExperimentArm[] = vs.map((v) => ({
        variant_id: v.id,
        label: v.label,
        is_control: v.is_control,
        sessions: v.sessions ?? 0,
        conversions: v.conversions ?? 0,
        sub_attach: v.sub_attach ?? 0,
        revenue_cents: v.revenue_cents ?? 0,
        win_prob:
          v.is_control || !control
            ? null
            : Math.round(winProbabilityVsControl(v, control, 2000) * 1000) / 1000,
      }));
      out.push({
        experiment_id: e.id,
        product_id: e.product_id,
        lever: e.lever,
        lander_type: e.lander_type,
        status: e.status,
        holdout_pct: e.holdout_pct,
        arms,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface PredictedLtvCohort {
  product_id: string;
  product_title: string;
  lander_type: string;
  audience: string;
  snapshot_date: string;
  visitors: number;
  sub_attach_rate: number;
  est_sub_ltv_cents: number;
  predicted_ltv_per_visitor_cents: number;
  /** Most recent snapshot at least ~7 days before `snapshot_date`, for the WoW delta. */
  prior_snapshot_date: string | null;
  prior_predicted_ltv_per_visitor_cents: number | null;
  /** Signed % change vs the prior-week snapshot (null when no prior snapshot exists). */
  wow_delta_pct: number | null;
  weights_version: number;
  calibrated: boolean;
  flags: Record<string, unknown>;
}

/**
 * Predicted-LTV-per-visitor per cohort, current snapshot vs the prior-week snapshot.
 * Reads the [[storefront_ltv_metrics]] rows the M3 fast loop persists daily; for each
 * `(product × lander × audience)` cohort it takes the latest snapshot as "current" and the
 * newest snapshot ≥7 days older as the week-over-week baseline. Best-effort — returns [] if
 * the table is absent (M3 not yet shipped in this environment).
 */
async function buildPredictedLtv(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<PredictedLtvCohort[]> {
  try {
    // ~5 weeks of snapshots so a cohort that didn't snapshot exactly 7 days ago still has a
    // sensible prior baseline.
    const sinceIso = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: rows } = await admin
      .from("storefront_ltv_metrics")
      .select("product_id, lander_type, audience, snapshot_date, visitors, sub_attach_rate, est_sub_ltv_cents, predicted_ltv_per_visitor_cents, weights_version, calibrated, flags")
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", sinceIso)
      .order("snapshot_date", { ascending: false });
    if (!rows?.length) return [];

    type Row = {
      product_id: string; lander_type: string; audience: string; snapshot_date: string;
      visitors: number; sub_attach_rate: number; est_sub_ltv_cents: number;
      predicted_ltv_per_visitor_cents: number; weights_version: number; calibrated: boolean;
      flags: Record<string, unknown> | null;
    };
    // Group by cohort, snapshots already newest-first.
    const byCohort = new Map<string, Row[]>();
    for (const r of rows as Row[]) {
      const k = `${r.product_id}|${r.lander_type}|${r.audience}`;
      const arr = byCohort.get(k) ?? [];
      arr.push(r);
      byCohort.set(k, arr);
    }

    // Resolve product titles for the cohorts in view.
    const productIds = [...new Set((rows as Row[]).map((r) => r.product_id))];
    const { data: productRows } = productIds.length
      ? await admin.from("products").select("id, title").in("id", productIds)
      : { data: [] as { id: string; title: string }[] };
    const titleById = new Map((productRows || []).map((p) => [p.id, p.title]));

    const out: PredictedLtvCohort[] = [];
    for (const snapshots of byCohort.values()) {
      const current = snapshots[0];
      // Prior-week baseline = newest snapshot at least 7 days before current.
      const currentMs = new Date(current.snapshot_date).getTime();
      const prior = snapshots.find((s) => currentMs - new Date(s.snapshot_date).getTime() >= 7 * 24 * 60 * 60 * 1000) ?? null;
      const cur = current.predicted_ltv_per_visitor_cents;
      const priorVal = prior?.predicted_ltv_per_visitor_cents ?? null;
      const wow = priorVal && priorVal > 0 ? Math.round(((cur - priorVal) / priorVal) * 1000) / 10 : null;
      out.push({
        product_id: current.product_id,
        product_title: titleById.get(current.product_id) || "(unknown)",
        lander_type: current.lander_type,
        audience: current.audience,
        snapshot_date: current.snapshot_date,
        visitors: current.visitors,
        sub_attach_rate: current.sub_attach_rate,
        est_sub_ltv_cents: current.est_sub_ltv_cents,
        predicted_ltv_per_visitor_cents: cur,
        prior_snapshot_date: prior?.snapshot_date ?? null,
        prior_predicted_ltv_per_visitor_cents: priorVal,
        wow_delta_pct: wow,
        weights_version: current.weights_version,
        calibrated: current.calibrated,
        flags: current.flags ?? {},
      });
    }
    // Highest-value cohorts first.
    return out.sort((a, b) => b.predicted_ltv_per_visitor_cents - a.predicted_ltv_per_visitor_cents);
  } catch {
    return [];
  }
}

export interface CampaignGradeRow {
  grade_id: string;
  experiment_id: string;
  product_id: string;
  product_title: string;
  lever: string;
  lander_type: string;
  audience: string;
  status: string;
  grade_initial: number | null;
  grade_revised: number | null;
  hypothesis_quality: number | null;
  result_quality: number | null;
  grade_initial_reasoning: string | null;
  grade_revised_reasoning: string | null;
  graded_by: string;
  overridden_by: string | null;
  initial_graded_at: string | null;
  revised_graded_at: string | null;
}
export interface CampaignGradesBlock {
  graded: number;
  /** Agent average of the latest grade (revised ?? initial) across all graded campaigns. */
  avg_grade: number | null;
  /** Average hypothesis_quality (the sound-bet metric we train toward). */
  avg_hypothesis_quality: number | null;
  /** Chronological grade trend points (oldest→newest) for the average-grade trend sparkline. */
  trend: Array<{ at: string; grade: number }>;
  /** Proposed calibration rules awaiting the Growth director's approval. */
  proposed_rules: Array<{ id: string; title: string; content: string; created_at: string }>;
  rows: CampaignGradeRow[];
}

/**
 * The M5 campaign-grading report: every concluded M4 campaign with its initial + revised grade,
 * the hypothesis/result sub-scores, who graded it, and the agent's average-grade trend (the
 * supervised metric the Growth director watches). Plus the proposed calibration rules awaiting
 * approval. Best-effort — returns an empty block if storefront_campaign_grades is absent.
 */
async function buildCampaignGrades(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<CampaignGradesBlock> {
  const empty: CampaignGradesBlock = { graded: 0, avg_grade: null, avg_hypothesis_quality: null, trend: [], proposed_rules: [], rows: [] };
  try {
    const { data: grades } = await admin
      .from("storefront_campaign_grades")
      .select("id, experiment_id, grade_initial, grade_revised, hypothesis_quality, result_quality, grade_initial_reasoning, grade_revised_reasoning, graded_by, overridden_by, initial_graded_at, revised_graded_at, created_at")
      .eq("workspace_id", workspaceId)
      .not("grade_initial", "is", null)
      .order("initial_graded_at", { ascending: false })
      .limit(200);
    const gradeRows = (grades || []) as Array<{
      id: string; experiment_id: string; grade_initial: number | null; grade_revised: number | null;
      hypothesis_quality: number | null; result_quality: number | null; grade_initial_reasoning: string | null;
      grade_revised_reasoning: string | null; graded_by: string; overridden_by: string | null;
      initial_graded_at: string | null; revised_graded_at: string | null; created_at: string;
    }>;
    if (!gradeRows.length) {
      // Still surface any proposed calibration rules even with no graded campaigns yet.
      const { data: rules0 } = await admin
        .from("storefront_grader_prompts")
        .select("id, title, content, created_at")
        .eq("workspace_id", workspaceId)
        .eq("status", "proposed")
        .order("created_at", { ascending: false })
        .limit(25);
      return { ...empty, proposed_rules: (rules0 || []) as CampaignGradesBlock["proposed_rules"] };
    }

    const expIds = gradeRows.map((g) => g.experiment_id);
    const { data: exps } = await admin
      .from("storefront_experiments")
      .select("id, product_id, lever, lander_type, audience, status")
      .in("id", expIds);
    const expById = new Map(((exps || []) as Array<{ id: string; product_id: string; lever: string; lander_type: string; audience: string; status: string }>).map((e) => [e.id, e]));

    const productIds = [...new Set(((exps || []) as Array<{ product_id: string }>).map((e) => e.product_id))];
    const { data: productRows } = productIds.length
      ? await admin.from("products").select("id, title").in("id", productIds)
      : { data: [] as { id: string; title: string }[] };
    const titleById = new Map(((productRows || []) as { id: string; title: string }[]).map((p) => [p.id, p.title]));

    const rows: CampaignGradeRow[] = gradeRows.map((g) => {
      const e = expById.get(g.experiment_id);
      return {
        grade_id: g.id,
        experiment_id: g.experiment_id,
        product_id: e?.product_id || "",
        product_title: e ? titleById.get(e.product_id) || "(unknown)" : "(unknown)",
        lever: e?.lever || "(unknown)",
        lander_type: e?.lander_type || "—",
        audience: e?.audience || "all",
        status: e?.status || "—",
        grade_initial: g.grade_initial,
        grade_revised: g.grade_revised,
        hypothesis_quality: g.hypothesis_quality,
        result_quality: g.result_quality,
        grade_initial_reasoning: g.grade_initial_reasoning,
        grade_revised_reasoning: g.grade_revised_reasoning,
        graded_by: g.graded_by,
        overridden_by: g.overridden_by,
        initial_graded_at: g.initial_graded_at,
        revised_graded_at: g.revised_graded_at,
      };
    });

    // Agent metric: average of the latest grade (revised supersedes initial) + hypothesis quality.
    let gradeSum = 0;
    let gradeN = 0;
    let hypSum = 0;
    let hypN = 0;
    for (const g of gradeRows) {
      const latest = g.grade_revised ?? g.grade_initial;
      if (latest != null) { gradeSum += latest; gradeN++; }
      if (g.hypothesis_quality != null) { hypSum += g.hypothesis_quality; hypN++; }
    }
    // Trend: oldest→newest by initial_graded_at (the supervised average-grade-over-time view).
    const trend = [...gradeRows]
      .filter((g) => g.initial_graded_at)
      .sort((a, b) => new Date(a.initial_graded_at!).getTime() - new Date(b.initial_graded_at!).getTime())
      .map((g) => ({ at: g.initial_graded_at!, grade: g.grade_revised ?? g.grade_initial! }));

    const { data: rules } = await admin
      .from("storefront_grader_prompts")
      .select("id, title, content, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "proposed")
      .order("created_at", { ascending: false })
      .limit(25);

    return {
      graded: gradeN,
      avg_grade: gradeN > 0 ? Math.round((gradeSum / gradeN) * 100) / 100 : null,
      avg_hypothesis_quality: hypN > 0 ? Math.round((hypSum / hypN) * 100) / 100 : null,
      trend,
      proposed_rules: (rules || []) as CampaignGradesBlock["proposed_rules"],
      rows,
    };
  } catch {
    return empty;
  }
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
