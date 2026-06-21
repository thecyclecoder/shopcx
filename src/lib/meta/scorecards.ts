/**
 * Iteration scorecards — Storefront Iteration Engine Phase 3.
 *
 * The deterministic daily metrics the controller reads. The decision engine
 * (Phases 4/6) reads THIS table only — never the raw session/insight tables — so
 * every metric it acts on is traceable to a persisted `iteration_scorecards_daily`
 * row by id. One row per (workspace_id, level, object_id, snapshot_date), where
 * `level` ∈ ad | adset | campaign | variant | angle.
 *
 * Each row is a TRAILING-WINDOW rollup (default 7 days) ending at `snapshot_date`,
 * with the prior equal-length window stored for trend + fatigue signals.
 *
 * Sources (all already-rolled-up Phase 1/2 outputs + structure):
 *   - ad/adset/campaign → `meta_insights_daily` (authoritative Meta perf) +
 *     `meta_ads`/`meta_adsets`/`meta_campaigns` (name, status, days_live,
 *     creatives_live).
 *   - variant/angle     → `meta_attribution_daily` (per-variant attributed spend +
 *     revenue + sessions + orders); variant ATC from `storefront_events`.
 *   - angle benefit     → angle_id → `product_ad_angles.lead_benefit_anchor` →
 *     `product_benefit_selections` (role='lead' AND science_confirmed=true).
 *
 * Idempotent: upserts on (workspace_id, level, object_id, snapshot_date).
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 3).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { UNRESOLVED_VARIANT } from "@/lib/meta/attribution";

export type ScorecardLevel = "ad" | "adset" | "campaign" | "variant" | "angle";

export interface ScorecardParams {
  workspaceId: string;
  adAccountId: string; // our DB uuid for meta_ad_accounts
}

export interface ScorecardResult {
  snapshotDate: string;
  windowDays: number;
  rows: number;
  counts: Record<ScorecardLevel, number>;
  variant_attribution_coverage: number | null;
}

// ── date helpers ───────────────────────────────────────────────────────────────

const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const dayMinus = (base: string, n: number) =>
  dayStr(new Date(new Date(`${base}T00:00:00Z`).getTime() - n * 86400000));
const daysBetween = (fromIso: string, toDate: string): number =>
  Math.max(0, Math.floor((new Date(`${toDate}T23:59:59Z`).getTime() - new Date(fromIso).getTime()) / 86400000));

/** The `?angle={slug}` param off a stored landing_url (the lander identity key). */
function parseAngle(landingUrl: string | null): string | null {
  if (!landingUrl) return null;
  try {
    return new URL(landingUrl).searchParams.get("angle");
  } catch {
    return null;
  }
}
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Page past PostgREST's 1000-row cap (mirrors attribution.ts / the dashboards).
async function fetchAllRows<T>(
  makeQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
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

const round = (n: number, p = 4) => Number(n.toFixed(p));
const pctDelta = (curr: number, prev: number): number | null =>
  prev > 0 ? round((curr - prev) / prev) : null;

// ── window accumulator ─────────────────────────────────────────────────────────

interface Acc {
  // current window
  spend: number;
  revenue: number;
  impressions: number;
  clicks: number;
  purchases: number;
  orders: number;
  sessions: number;
  freqSum: number;
  freqDays: number;
  activeDays: Set<string>;
  // prior window
  pSpend: number;
  pRevenue: number;
  pImpressions: number;
  pClicks: number;
  pSessions: number;
  pOrders: number;
  pPurchases: number;
  pFreqSum: number;
  pFreqDays: number;
}

const newAcc = (): Acc => ({
  spend: 0, revenue: 0, impressions: 0, clicks: 0, purchases: 0, orders: 0, sessions: 0,
  freqSum: 0, freqDays: 0, activeDays: new Set(),
  pSpend: 0, pRevenue: 0, pImpressions: 0, pClicks: 0, pSessions: 0, pOrders: 0, pPurchases: 0, pFreqSum: 0, pFreqDays: 0,
});

/** Derive the persisted metric columns from an accumulator + cvr basis. */
function metricsFromAcc(a: Acc, cvrBasis: "clicks" | "sessions") {
  const roas = a.spend > 0 ? round(a.revenue / a.spend) : 0;
  const ctr = a.impressions > 0 ? round((a.clicks / a.impressions) * 100) : 0;
  const cpc_cents = a.clicks > 0 ? Math.round(a.spend / a.clicks) : 0;
  const frequency = a.freqDays > 0 ? round(a.freqSum / a.freqDays) : 0;
  const cvr =
    cvrBasis === "clicks"
      ? a.clicks > 0 ? round(a.purchases / a.clicks) : 0
      : a.sessions > 0 ? round(a.orders / a.sessions) : 0;

  const roas_prev = a.pSpend > 0 ? round(a.pRevenue / a.pSpend) : 0;
  const ctr_prev = a.pImpressions > 0 ? round((a.pClicks / a.pImpressions) * 100) : 0;
  const frequency_prev = a.pFreqDays > 0 ? round(a.pFreqSum / a.pFreqDays) : 0;
  const cvr_prev =
    cvrBasis === "clicks"
      ? a.pClicks > 0 ? round(a.pPurchases / a.pClicks) : 0
      : a.pSessions > 0 ? round(a.pOrders / a.pSessions) : 0;

  // Fatigue — components are 0 when their inputs are absent (variant/angle have no CTR/freq).
  const ctr_declining = ctr_prev > 0 && ctr < ctr_prev * 0.9; // >10% CTR decline vs prior
  const frequency_rising = frequency_prev > 0 && frequency > frequency_prev * 1.05; // >5% freq rise
  let fatigue = 0;
  if (ctr_prev > 0 && ctr < ctr_prev) fatigue += 0.4 * Math.min(1, (ctr_prev - ctr) / ctr_prev / 0.5);
  if (frequency_prev > 0 && frequency > frequency_prev) fatigue += 0.3 * Math.min(1, (frequency - frequency_prev) / frequency_prev / 0.5);
  if (roas_prev > 0 && roas < roas_prev) fatigue += 0.3 * Math.min(1, (roas_prev - roas) / roas_prev);
  const fatigue_score = round(Math.min(1, fatigue), 3);

  return {
    spend_cents: a.spend,
    revenue_cents: a.revenue,
    roas,
    impressions: a.impressions,
    clicks: a.clicks,
    ctr,
    cpc_cents,
    frequency,
    purchases: a.purchases,
    orders: a.orders,
    sessions: a.sessions,
    cvr,
    spend_prev_cents: a.pSpend,
    revenue_prev_cents: a.pRevenue,
    roas_prev,
    ctr_prev,
    frequency_prev,
    sessions_prev: a.pSessions,
    cvr_prev,
    roas_delta_pct: pctDelta(roas, roas_prev),
    ctr_delta_pct: pctDelta(ctr, ctr_prev),
    spend_delta_pct: pctDelta(a.spend, a.pSpend),
    revenue_delta_pct: pctDelta(a.revenue, a.pRevenue),
    ctr_declining,
    frequency_rising,
    fatigue_score,
  };
}

// ── core ─────────────────────────────────────────────────────────────────────

/**
 * Compute + persist all scorecard levels for one account as-of `snapshotDate`
 * (Central/UTC date string). Aggregates a trailing `windowDays` window and the
 * prior equal-length window for trend. Idempotent upsert.
 */
export async function computeScorecards(
  p: ScorecardParams,
  snapshotDate: string,
  windowDays = 7,
): Promise<ScorecardResult> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const currStart = dayMinus(snapshotDate, windowDays - 1);
  const currEnd = snapshotDate;
  const prevStart = dayMinus(snapshotDate, 2 * windowDays - 1);
  const prevEnd = dayMinus(snapshotDate, windowDays);
  const inCurr = (d: string) => d >= currStart && d <= currEnd;
  const inPrev = (d: string) => d >= prevStart && d <= prevEnd;

  // ── Structure: meta ads/adsets/campaigns (labels, status, parents, created) ───
  const [adRows, adsetRows, campRows] = await Promise.all([
    fetchAllRows<{ meta_ad_id: string; meta_adset_id: string | null; meta_campaign_id: string | null; name: string | null; status: string | null; effective_status: string | null; meta_created_time: string | null }>(() =>
      admin.from("meta_ads").select("meta_ad_id, meta_adset_id, meta_campaign_id, name, status, effective_status, meta_created_time").eq("meta_ad_account_id", p.adAccountId).order("meta_ad_id", { ascending: true })),
    fetchAllRows<{ meta_adset_id: string; meta_campaign_id: string | null; name: string | null; status: string | null; effective_status: string | null; meta_created_time: string | null }>(() =>
      admin.from("meta_adsets").select("meta_adset_id, meta_campaign_id, name, status, effective_status, meta_created_time").eq("meta_ad_account_id", p.adAccountId).order("meta_adset_id", { ascending: true })),
    fetchAllRows<{ meta_campaign_id: string; name: string | null; status: string | null; effective_status: string | null; meta_created_time: string | null }>(() =>
      admin.from("meta_campaigns").select("meta_campaign_id, name, status, effective_status, meta_created_time").eq("meta_ad_account_id", p.adAccountId).order("meta_campaign_id", { ascending: true })),
  ]);

  const adMeta = new Map(adRows.map((a) => [a.meta_ad_id, a]));
  const adsetMeta = new Map(adsetRows.map((a) => [a.meta_adset_id, a]));
  const campMeta = new Map(campRows.map((c) => [c.meta_campaign_id, c]));
  const isActive = (status: string | null, eff: string | null) => status === "ACTIVE" || eff === "ACTIVE";

  // creatives_live: count of ACTIVE child ads per adset / per campaign.
  const liveByAdset = new Map<string, number>();
  const liveByCampaign = new Map<string, number>();
  for (const a of adRows) {
    if (!isActive(a.status, a.effective_status)) continue;
    if (a.meta_adset_id) liveByAdset.set(a.meta_adset_id, (liveByAdset.get(a.meta_adset_id) || 0) + 1);
    if (a.meta_campaign_id) liveByCampaign.set(a.meta_campaign_id, (liveByCampaign.get(a.meta_campaign_id) || 0) + 1);
  }

  // ── meta_insights_daily → ad/adset/campaign accumulators ─────────────────────
  const insightRows = await fetchAllRows<{ level: string; meta_object_id: string; snapshot_date: string; spend_cents: number | null; impressions: number | null; clicks: number | null; purchases: number | null; revenue_cents: number | null; frequency: number | null }>(() =>
    admin
      .from("meta_insights_daily")
      .select("level, meta_object_id, snapshot_date, spend_cents, impressions, clicks, purchases, revenue_cents, frequency")
      .eq("meta_ad_account_id", p.adAccountId)
      .in("level", ["ad", "adset", "campaign"])
      .gte("snapshot_date", prevStart)
      .lte("snapshot_date", currEnd)
      .order("meta_object_id", { ascending: true }),
  );

  const accByLevel: Record<"ad" | "adset" | "campaign", Map<string, Acc>> = { ad: new Map(), adset: new Map(), campaign: new Map() };
  const getAcc = (m: Map<string, Acc>, id: string): Acc => {
    let a = m.get(id);
    if (!a) { a = newAcc(); m.set(id, a); }
    return a;
  };
  for (const r of insightRows) {
    const lvl = r.level as "ad" | "adset" | "campaign";
    const m = accByLevel[lvl];
    if (!m) continue;
    const a = getAcc(m, r.meta_object_id);
    const spend = r.spend_cents || 0;
    const rev = r.revenue_cents || 0;
    const impr = r.impressions || 0;
    const clk = r.clicks || 0;
    const pur = r.purchases || 0;
    const freq = r.frequency || 0;
    if (inCurr(r.snapshot_date)) {
      a.spend += spend; a.revenue += rev; a.impressions += impr; a.clicks += clk; a.purchases += pur;
      if (freq > 0) { a.freqSum += freq; a.freqDays += 1; }
      if (spend > 0 || impr > 0) a.activeDays.add(r.snapshot_date);
    } else if (inPrev(r.snapshot_date)) {
      a.pSpend += spend; a.pRevenue += rev; a.pImpressions += impr; a.pClicks += clk; a.pPurchases += pur;
      if (freq > 0) { a.pFreqSum += freq; a.pFreqDays += 1; }
    }
  }

  // ── meta_attribution_daily → variant + angle accumulators ────────────────────
  const attrRows = await fetchAllRows<{ meta_ad_id: string; variant: string; snapshot_date: string; angle_id: string | null; advertorial_page_id: string | null; sessions: number | null; attributed_spend_cents: number | null; orders: number | null; revenue_cents: number | null }>(() =>
    admin
      .from("meta_attribution_daily")
      .select("meta_ad_id, variant, snapshot_date, angle_id, advertorial_page_id, sessions, attributed_spend_cents, orders, revenue_cents")
      .eq("meta_ad_account_id", p.adAccountId)
      .gte("snapshot_date", prevStart)
      .lte("snapshot_date", currEnd)
      .order("meta_ad_id", { ascending: true }),
  );

  const variantAcc = new Map<string, Acc>();
  const angleAcc = new Map<string, Acc>();
  // dominant lander page id per variant (legibility) + per angle
  const variantPage = new Map<string, Map<string, number>>();
  // account-level coverage (resolved vs total Meta sessions) over the current window
  let covTotalSessions = 0;
  let covResolvedSessions = 0;

  for (const r of attrRows) {
    const spend = r.attributed_spend_cents || 0;
    const rev = r.revenue_cents || 0;
    const sess = r.sessions || 0;
    const ord = r.orders || 0;
    const curr = inCurr(r.snapshot_date);
    const prev = inPrev(r.snapshot_date);

    // variant level (includes the '(unresolved)' bucket — surfaced, not dropped)
    const va = getAcc(variantAcc, r.variant);
    if (curr) {
      va.spend += spend; va.revenue += rev; va.sessions += sess; va.orders += ord;
      if (spend > 0 || sess > 0) va.activeDays.add(r.snapshot_date);
      if (r.advertorial_page_id) {
        let m = variantPage.get(r.variant);
        if (!m) { m = new Map(); variantPage.set(r.variant, m); }
        m.set(r.advertorial_page_id, (m.get(r.advertorial_page_id) || 0) + sess + 1);
      }
      covTotalSessions += sess;
      if (r.variant !== UNRESOLVED_VARIANT) covResolvedSessions += sess;
    } else if (prev) {
      va.pSpend += spend; va.pRevenue += rev; va.pSessions += sess; va.pOrders += ord;
    }

    // angle level (only resolvable, active angles — see filter below)
    if (r.angle_id) {
      const aa = getAcc(angleAcc, r.angle_id);
      if (curr) {
        aa.spend += spend; aa.revenue += rev; aa.sessions += sess; aa.orders += ord;
        if (spend > 0 || sess > 0) aa.activeDays.add(r.snapshot_date);
      } else if (prev) {
        aa.pSpend += spend; aa.pRevenue += rev; aa.pSessions += sess; aa.pOrders += ord;
      }
    }
  }
  const variant_attribution_coverage = covTotalSessions > 0 ? round(covResolvedSessions / covTotalSessions) : null;

  // ── Angle → benefit resolution (lead_benefit_anchor → qualifying selection) ──
  const angleIds = [...angleAcc.keys()];
  const angleMeta = new Map<string, { lead_benefit_anchor: string | null; is_active: boolean }>();
  if (angleIds.length) {
    const angRows = await fetchAllRows<{ id: string; lead_benefit_anchor: string | null; is_active: boolean | null }>(() =>
      admin.from("product_ad_angles").select("id, lead_benefit_anchor, is_active").in("id", angleIds).order("id", { ascending: true }));
    for (const r of angRows) angleMeta.set(r.id, { lead_benefit_anchor: r.lead_benefit_anchor, is_active: r.is_active !== false });
  }
  // Qualifying lead benefits — role='lead' AND science_confirmed=true (Phase 3 filter).
  const { data: benefitRows } = await admin
    .from("product_benefit_selections")
    .select("benefit_name")
    .eq("workspace_id", p.workspaceId)
    .eq("role", "lead")
    .eq("science_confirmed", true);
  const qualifyingBenefits = new Set((benefitRows || []).map((b) => (b.benefit_name as string | null) || "").filter(Boolean));

  // ── Variant ATC (current window) — sessions with an add_to_cart event ─────────
  // Map Meta session → variant (persisted advertorial_page_id → variant, else parse
  // ?angle from landing_url), then count distinct ATC sessions per variant.
  const { data: advRows } = await admin
    .from("advertorial_pages")
    .select("id, slug, variant")
    .eq("workspace_id", p.workspaceId);
  const variantBySlug = new Map<string, string>();
  const variantByPageId = new Map<string, string>();
  for (const a of (advRows || []) as { id: string; slug: string | null; variant: string | null }[]) {
    const v = a.variant || "advertorial";
    if (a.slug) variantBySlug.set(a.slug, v);
    variantByPageId.set(a.id, v);
  }
  const currStartIso = `${currStart}T00:00:00Z`;
  const currEndIso = `${currEnd}T23:59:59Z`;
  const sessRows = await fetchAllRows<{ id: string; landing_url: string | null; advertorial_page_id: string | null; is_internal: boolean | null; is_bot: boolean | null }>(() =>
    admin.from("storefront_sessions").select("id, landing_url, advertorial_page_id, is_internal, is_bot").eq("workspace_id", p.workspaceId).eq("utm_source", "meta").gte("first_seen_at", currStartIso).lte("first_seen_at", currEndIso).order("id", { ascending: true }));
  const sessionVariant = new Map<string, string>();
  for (const s of sessRows) {
    if (s.is_internal || s.is_bot) continue;
    let v: string | undefined;
    if (s.advertorial_page_id) v = variantByPageId.get(s.advertorial_page_id);
    if (!v) {
      const slug = parseAngle(s.landing_url);
      if (slug) v = variantBySlug.get(slug) || variantBySlug.get(decode(slug));
    }
    if (v) sessionVariant.set(s.id, v);
  }
  const atcSessionsByVariant = new Map<string, Set<string>>();
  if (sessionVariant.size) {
    const atcEvents = await fetchAllRows<{ session_id: string }>(() =>
      admin.from("storefront_events").select("session_id").eq("workspace_id", p.workspaceId).eq("event_type", "add_to_cart").gte("created_at", currStartIso).lte("created_at", currEndIso).order("id", { ascending: true }));
    for (const e of atcEvents) {
      const v = sessionVariant.get(e.session_id);
      if (!v) continue;
      let set = atcSessionsByVariant.get(v);
      if (!set) { set = new Set(); atcSessionsByVariant.set(v, set); }
      set.add(e.session_id);
    }
  }

  // ── Materialize rows ─────────────────────────────────────────────────────────
  type Row = Record<string, unknown>;
  const records: Row[] = [];
  const base = (level: ScorecardLevel, objectId: string) => ({
    workspace_id: p.workspaceId,
    meta_ad_account_id: p.adAccountId,
    level,
    object_id: objectId,
    snapshot_date: snapshotDate,
    window_days: windowDays,
    synced_at: now,
    updated_at: now,
  });

  // ad
  for (const [adId, a] of accByLevel.ad) {
    const meta = adMeta.get(adId);
    const m = metricsFromAcc(a, "clicks");
    records.push({
      ...base("ad", adId),
      label: meta?.name ?? null,
      effective_status: meta?.effective_status ?? meta?.status ?? null,
      parent_adset_id: meta?.meta_adset_id ?? null,
      parent_campaign_id: meta?.meta_campaign_id ?? null,
      days_live: meta?.meta_created_time ? daysBetween(meta.meta_created_time, currEnd) : a.activeDays.size,
      creatives_live: 0,
      ...m,
    });
  }
  // adset
  for (const [adsetId, a] of accByLevel.adset) {
    const meta = adsetMeta.get(adsetId);
    const m = metricsFromAcc(a, "clicks");
    records.push({
      ...base("adset", adsetId),
      label: meta?.name ?? null,
      effective_status: meta?.effective_status ?? meta?.status ?? null,
      parent_campaign_id: meta?.meta_campaign_id ?? null,
      days_live: meta?.meta_created_time ? daysBetween(meta.meta_created_time, currEnd) : a.activeDays.size,
      creatives_live: liveByAdset.get(adsetId) || 0,
      ...m,
    });
  }
  // campaign
  for (const [campId, a] of accByLevel.campaign) {
    const meta = campMeta.get(campId);
    const m = metricsFromAcc(a, "clicks");
    records.push({
      ...base("campaign", campId),
      label: meta?.name ?? null,
      effective_status: meta?.effective_status ?? meta?.status ?? null,
      days_live: meta?.meta_created_time ? daysBetween(meta.meta_created_time, currEnd) : a.activeDays.size,
      creatives_live: liveByCampaign.get(campId) || 0,
      ...m,
    });
  }
  // variant
  for (const [variant, a] of variantAcc) {
    const m = metricsFromAcc(a, "sessions");
    const atc = atcSessionsByVariant.get(variant)?.size || 0;
    const atc_rate = a.sessions > 0 ? round(Math.min(1, atc / a.sessions)) : 0;
    // dominant lander page for legibility
    let pageId: string | null = null;
    const pm = variantPage.get(variant);
    if (pm) { let best = -1; for (const [pid, n] of pm) if (n > best) { best = n; pageId = pid; } }
    records.push({
      ...base("variant", variant),
      label: variant,
      advertorial_page_id: pageId,
      days_live: a.activeDays.size,
      creatives_live: 0,
      atc,
      atc_rate,
      variant_attribution_coverage,
      ...m,
    });
  }
  // angle — Phase 3 filter: is_active angles whose lead benefit qualifies.
  for (const [angleId, a] of angleAcc) {
    const meta = angleMeta.get(angleId);
    if (meta && !meta.is_active) continue; // archived angle — skip
    const anchor = meta?.lead_benefit_anchor ?? null;
    const benefit_name = anchor && qualifyingBenefits.has(anchor) ? anchor : null;
    const m = metricsFromAcc(a, "sessions");
    records.push({
      ...base("angle", angleId),
      label: benefit_name ?? anchor ?? null,
      angle_id: angleId,
      lead_benefit_anchor: anchor,
      benefit_name,
      days_live: a.activeDays.size,
      creatives_live: 0,
      variant_attribution_coverage,
      ...m,
    });
  }

  // ── FK-resilience — null any reference column whose target row isn't present ──
  // `.upsert()` is all-or-nothing per batch, so a single dangling foreign key
  // (angle_id → product_ad_angles, advertorial_page_id → advertorial_pages) would
  // otherwise reject all ~500 rows in the batch and the whole rollup would persist
  // 0 rows. A scorecard row is still valid with a null ref, so we drop the dangling
  // pointer rather than the row. We resolve "exists" against the rows this run
  // already fetched: product_ad_angles (angleMeta), advertorial_pages
  // (variantByPageId), meta_adsets/meta_campaigns (the structure maps). The two
  // uuid columns are real FKs; the two text parent columns aren't constrained but
  // we keep them legible by only emitting resolvable ids.
  const knownAngleIds = new Set(angleMeta.keys());
  const knownPageIds = new Set(variantByPageId.keys());
  const knownAdsetIds = new Set(adsetMeta.keys());
  const knownCampaignIds = new Set(campMeta.keys());
  for (const r of records) {
    if (r.angle_id != null && !knownAngleIds.has(r.angle_id as string)) r.angle_id = null;
    if (r.advertorial_page_id != null && !knownPageIds.has(r.advertorial_page_id as string)) r.advertorial_page_id = null;
    if (r.parent_adset_id != null && !knownAdsetIds.has(r.parent_adset_id as string)) r.parent_adset_id = null;
    if (r.parent_campaign_id != null && !knownCampaignIds.has(r.parent_campaign_id as string)) r.parent_campaign_id = null;
  }

  // ── Persist — capture every batch's { error }; NEVER report rows we didn't write ──
  // On a batch error, fall back to per-row upsert so one bad record is isolated +
  // logged instead of dropping its 499 neighbors. `persisted` is the count that
  // actually landed; on any unrecoverable error we throw with the PG code+message
  // so the run fails loudly (and names the offending constraint) rather than
  // reporting success with 0 written.
  let persisted = 0;
  let firstError: { code: string | null; message: string } | null = null;
  const noteError = (e: { code?: string | null; message?: string }, ctx: string) => {
    const code = e.code ?? null;
    const message = e.message ?? "unknown error";
    if (!firstError) firstError = { code, message };
    console.error(`[scorecards] iteration_scorecards_daily upsert failed ${ctx}: ${code ?? "?"} ${message}`);
  };
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const { error } = await admin
      .from("iteration_scorecards_daily")
      .upsert(batch, { onConflict: "workspace_id,level,object_id,snapshot_date" });
    if (!error) {
      persisted += batch.length;
      continue;
    }
    // Batch rejected as a unit — isolate the offending record(s).
    console.error(
      `[scorecards] batch upsert failed (rows ${i}..${i + batch.length - 1}): ` +
        `${(error as { code?: string }).code ?? "?"} ${error.message} — retrying per-row`,
    );
    for (const rec of batch) {
      const { error: rowErr } = await admin
        .from("iteration_scorecards_daily")
        .upsert([rec], { onConflict: "workspace_id,level,object_id,snapshot_date" });
      if (rowErr) noteError(rowErr, `${rec.level}/${rec.object_id}`);
      else persisted += 1;
    }
  }
  if (firstError) {
    const { code, message } = firstError;
    throw new Error(
      `iteration_scorecards_daily upsert persisted ${persisted}/${records.length} rows; ` +
        `${records.length - persisted} failed: ${code ?? "?"} ${message}`,
    );
  }

  const counts: Record<ScorecardLevel, number> = {
    ad: accByLevel.ad.size,
    adset: accByLevel.adset.size,
    campaign: accByLevel.campaign.size,
    variant: variantAcc.size,
    angle: records.filter((r) => r.level === "angle").length,
  };
  return { snapshotDate, windowDays, rows: persisted, counts, variant_attribution_coverage };
}

// ── Orchestration ──────────────────────────────────────────────────────────--

/** Refresh scorecards for one account as-of today (Central/UTC date). */
export async function refreshScorecards(
  p: ScorecardParams,
  opts?: { snapshotDate?: string; windowDays?: number },
): Promise<ScorecardResult> {
  const snapshotDate = opts?.snapshotDate ?? dayStr(new Date());
  return computeScorecards(p, snapshotDate, opts?.windowDays ?? 7);
}
