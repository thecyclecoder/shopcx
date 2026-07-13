/**
 * testing-results-sdk — the read-only lens behind `/ad-testing-results`: ONE row per live test
 * (an ad set) across EVERY hero product, grouped by product → test campaign, sorted crowning-
 * potential → early dud. It answers the founder/Max question "which tests are winning, which are
 * dying, and is the structure sane?" without anyone hand-rolling a Graph call or a raw join.
 *
 * WHY a dedicated SDK (not the account-level [[./ad-insights-sdk|ads-analysis]] path): that lens is
 * per-AD, per-ACCOUNT, live-Graph, last_30d. This one is per-TEST (ad set), per-PRODUCT, and reads
 * the DB that the 2-hourly [[../inngest/media-buyer-test-cadence]] cron keeps fresh + TODAY-inclusive
 * (`meta_insights_daily`, adset level) — the SAME numbers Bianca acts on, so the report and the
 * agent agree. No `last_30d` (which drops today's ~$6/hr-per-test spend).
 *
 * The composition (all in this SDK, nothing raw in the skill script):
 *   • mapping     product → account + test campaign  ← [[../../tables/media_buyer_test_cohorts]]
 *                 (the DB that tells Bianca WHERE to publish each product's test).
 *   • structure   every ad set (incl. $0 / paused)   ← [[../../tables/meta_adsets]] (effective_status).
 *   • metrics     cumulative lifetime per ad set      ← Σ [[../../tables/meta_insights_daily]] (adset).
 *   • attribution ad set → product                   ← ad_publish_jobs.meta_adset_id → campaign_id
 *                 → ad_campaigns.product_id, with the ad-name label + single-product-campaign fallback.
 *   • tiering     crown/promising/testing/dud         ← the SSOT setpoints on [[../../tables/iteration_policies]]
 *                 (crown ≥8 purch @ CPA ≤ crown @ ≥ crown-spend · hold band · $ deadline · early trim).
 *
 * READ-ONLY. Surfaces policy violations (a campaign serving >1 product; >4 active tests; an unmapped
 * cohort) as flags — it never mutates. See [[../../docs/brain/libraries/testing-results-sdk.md]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** How far back "lifetime" reaches — tests are new; 180d bounds the scan while covering a whole test. */
const LIFETIME_LOOKBACK_DAYS = 180;
/** Per-campaign active-ad-set cap (methodology: ≤4 concurrent tests per product testing campaign). */
export const MAX_ACTIVE_TESTS_PER_CAMPAIGN = 4;

export type TestTier = "crown" | "promising" | "testing" | "dud";
const TIER_RANK: Record<TestTier, number> = { crown: 0, promising: 1, testing: 2, dud: 3 };

/** The crown/kill setpoints — SSOT is the workspace's active `iteration_policies` row (the SAME knobs
 *  the media-buyer's crown/trim signal reads). Code defaults mirror the seeded v1 policy. */
export interface TestThresholds {
  crownMaxCpaCents: number;    // CPA ≤ this to crown ($150)
  crownMinSpendCents: number;  // spend ≥ this to crown ($450 verdict floor)
  crownMinPurchases: number;   // purchases ≥ this to crown (8)
  holdBandMaxCpaCents: number; // crown < CPA ≤ this = hold/promising ($220)
  maxTestSpendCents: number;   // spend past this without crowning = dud (deadline, $1,200)
  earlyTrimMinSpendCents: number; // spend ≥ this with 0 purchases = early dud ($300)
}

const DEFAULT_THRESHOLDS: TestThresholds = {
  crownMaxCpaCents: 15000,
  crownMinSpendCents: 45000,
  crownMinPurchases: 8,
  holdBandMaxCpaCents: 22000,
  maxTestSpendCents: 120000,
  earlyTrimMinSpendCents: 30000,
};

export async function resolveTestThresholds(admin: Admin, workspaceId: string): Promise<TestThresholds> {
  const { data } = await admin
    .from("iteration_policies")
    .select("crown_max_cpa_cents, crown_min_spend_cents, crown_min_purchases, hold_band_max_cpa_cents, max_test_spend_cents, early_trim_min_spend_cents")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const p = (data ?? {}) as Record<string, number | null>;
  const n = (v: number | null | undefined, d: number) => (v == null ? d : Number(v));
  return {
    crownMaxCpaCents: n(p.crown_max_cpa_cents, DEFAULT_THRESHOLDS.crownMaxCpaCents),
    crownMinSpendCents: n(p.crown_min_spend_cents, DEFAULT_THRESHOLDS.crownMinSpendCents),
    crownMinPurchases: n(p.crown_min_purchases, DEFAULT_THRESHOLDS.crownMinPurchases),
    holdBandMaxCpaCents: n(p.hold_band_max_cpa_cents, DEFAULT_THRESHOLDS.holdBandMaxCpaCents),
    maxTestSpendCents: n(p.max_test_spend_cents, DEFAULT_THRESHOLDS.maxTestSpendCents),
    earlyTrimMinSpendCents: n(p.early_trim_min_spend_cents, DEFAULT_THRESHOLDS.earlyTrimMinSpendCents),
  };
}

/** Classify one test ad set's cumulative funnel into a crown→dud tier using the live setpoints. */
export function tierForTest(m: { spendCents: number; purchases: number; addToCart: number }, t: TestThresholds): TestTier {
  const cac = m.purchases > 0 ? m.spendCents / m.purchases : null;
  if (m.purchases >= t.crownMinPurchases && cac != null && cac <= t.crownMaxCpaCents && m.spendCents >= t.crownMinSpendCents) return "crown";
  if (m.purchases > 0 && cac != null && cac <= t.holdBandMaxCpaCents) return "promising";
  // Deadline dud: burned the full test budget without converting to the hold band.
  if (m.spendCents >= t.maxTestSpendCents && (m.purchases === 0 || (cac != null && cac > t.holdBandMaxCpaCents))) return "dud";
  // Early dud: real spend, zero purchases (kill fast on the leading signal, don't wait for the deadline).
  if (m.spendCents >= t.earlyTrimMinSpendCents && m.purchases === 0) return "dud";
  return "testing";
}

/** The creative shown for a test — image (thumbnail + modal) + copy. The publish row is a stale
 *  snapshot (copy edited on Meta after publish won't show here, and hero image is usually null), so
 *  `enrichWithMetaCreatives` overlays the LIVE Meta creative (SSOT) when a token is available. */
export interface TestCreative {
  heroImageUrl: string | null; // ad_campaigns.hero_image_url (a storage path/URL; usually null)
  headline: string | null;
  primaryText: string | null;
  description: string | null;
  adCampaignId: string | null;
  metaAdId: string | null;
  // ── overlaid by enrichWithMetaCreatives (live Meta creative — SSOT) ──
  thumbnailUrl?: string | null; // small preview (the grid thumbnail)
  imageUrl?: string | null;     // full-size (the modal)
  link?: string | null;         // the ad's destination
  metaEnriched?: boolean;       // true once the live creative overlaid image + copy
}

export interface TestAdsetRow {
  productId: string | null;
  productTitle: string;
  metaAccountId: string;
  metaAccountName: string;
  campaignId: string;
  adsetId: string;
  adsetName: string;
  effectiveStatus: string;
  active: boolean;
  // cumulative lifetime (Σ meta_insights_daily, adset level)
  spendCents: number;
  impressions: number;
  clicks: number;
  addToCart: number;
  purchases: number;
  revenueCents: number;
  // derived
  cpmCents: number;
  ctrPct: number;
  costPerAtcCents: number | null;
  cacCents: number | null;
  // tiering
  tier: TestTier;
  lastDataDate: string | null;
  // creative (for the page's thumbnail + modal); null for non-system-published tests.
  creative: TestCreative | null;
}

export interface ProductTestGroup {
  productId: string | null;
  productTitle: string;
  metaAccountName: string;
  campaignIds: string[];
  rows: TestAdsetRow[]; // sorted crown → dud
  activeCount: number;
  flags: string[];
}

export interface AccountFreshness {
  metaAccountName: string;
  metaAccountId: string;
  latestSnapshot: string | null;
  lastUpdated: string | null;
  ageHours: number | null;
}

export interface TestingResults {
  generatedAt: string;
  thresholds: TestThresholds;
  products: ProductTestGroup[]; // sorted best-tier first
  globalFlags: string[];
  freshness: AccountFreshness[];
}

// ── internal row shapes ──────────────────────────────────────────────────────────
interface CohortRow { product_id: string | null; meta_ad_account_id: string; test_meta_campaign_id: string | null; test_meta_adset_id: string | null; is_active: boolean; }
interface AdsetRow { meta_adset_id: string; meta_campaign_id: string | null; name: string | null; effective_status: string | null; }

const cac = (spendCents: number, purchases: number): number | null => (purchases > 0 ? Math.round(spendCents / purchases) : null);
const costPerAtc = (spendCents: number, atc: number): number | null => (atc > 0 ? Math.round(spendCents / atc) : null);

/**
 * The whole report. Reads the cohort mapping → resolves each product's test campaign(s) → pulls every
 * ad set's structure + cumulative funnel → attributes each ad set to its product → tiers + sorts.
 */
export async function getTestingResults(admin: Admin, workspaceId: string, nowMs: number = Date.now()): Promise<TestingResults> {
  const thresholds = await resolveTestThresholds(admin, workspaceId);
  const globalFlags: string[] = [];

  // 1) mapping — active test cohorts (product → account + test campaign).
  const { data: cohortData } = await admin
    .from("media_buyer_test_cohorts")
    .select("product_id, meta_ad_account_id, test_meta_campaign_id, test_meta_adset_id, is_active")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  const cohorts = (cohortData ?? []) as CohortRow[];

  // Identity lookups.
  const acctRowIds = [...new Set(cohorts.map((c) => c.meta_ad_account_id).filter(Boolean))];
  const [{ data: acctData }, { data: prodData }] = await Promise.all([
    admin.from("meta_ad_accounts").select("id, meta_account_id, meta_account_name").in("id", acctRowIds.length ? acctRowIds : ["_"]),
    admin.from("products").select("id, title").eq("workspace_id", workspaceId),
  ]);
  const acctById = new Map((acctData ?? []).map((a: Record<string, unknown>) => [String(a.id), { metaId: String(a.meta_account_id ?? ""), name: String(a.meta_account_name ?? "") }]));
  const productTitle = new Map((prodData ?? []).map((p: Record<string, unknown>) => [String(p.id), String(p.title ?? "")]));

  // 2) resolve each account's test campaigns. Prefer the cohort's test_meta_campaign_id; when null
  //    (a legacy/unmapped cohort, e.g. Tabs), fall back to the campaign of its test_meta_adset_id.
  const campaignToProducts = new Map<string, Set<string | null>>(); // campaignId → product_ids that map to it (via cohorts)
  const acctRowByCampaign = new Map<string, string>();
  const nullCampaignAdsetIds: string[] = [];
  for (const c of cohorts) {
    if (c.test_meta_campaign_id) {
      const s = campaignToProducts.get(c.test_meta_campaign_id) ?? new Set();
      s.add(c.product_id);
      campaignToProducts.set(c.test_meta_campaign_id, s);
      acctRowByCampaign.set(c.test_meta_campaign_id, c.meta_ad_account_id);
    } else if (c.test_meta_adset_id) {
      nullCampaignAdsetIds.push(c.test_meta_adset_id);
      if (c.product_id == null) globalFlags.push(`Cohort on account ${acctById.get(c.meta_ad_account_id)?.name ?? c.meta_ad_account_id} has no product_id AND no test campaign (legacy single-adset). Bianca can't map product→campaign here — see task #31.`);
    }
  }
  // Resolve null-campaign cohorts' campaign from their adset.
  if (nullCampaignAdsetIds.length) {
    const { data: adsetLk } = await admin.from("meta_adsets").select("meta_adset_id, meta_campaign_id, meta_ad_account_id").eq("workspace_id", workspaceId).in("meta_adset_id", nullCampaignAdsetIds);
    for (const a of (adsetLk ?? []) as Array<Record<string, unknown>>) {
      const camp = a.meta_campaign_id ? String(a.meta_campaign_id) : null;
      if (camp && !campaignToProducts.has(camp)) {
        campaignToProducts.set(camp, new Set([null]));
        acctRowByCampaign.set(camp, String(a.meta_ad_account_id));
      }
    }
  }

  // Flag campaigns that serve >1 product (the Ashwavana Guru Focus + Zen Relax defect).
  for (const [camp, prods] of campaignToProducts) {
    const named = [...prods].filter((p): p is string => !!p);
    if (named.length > 1) {
      const titles = named.map((p) => productTitle.get(p) ?? p);
      globalFlags.push(`Test campaign ${camp} serves ${named.length} products (${titles.join(" + ")}) — should be one campaign per product (see task #33).`);
    }
  }

  const campaignIds = [...campaignToProducts.keys()];
  if (!campaignIds.length) {
    return { generatedAt: new Date(nowMs).toISOString(), thresholds, products: [], globalFlags, freshness: [] };
  }

  // 3) structure — every ad set under the test campaigns (incl. $0 / paused).
  const { data: adsetData } = await admin
    .from("meta_adsets")
    .select("meta_adset_id, meta_campaign_id, name, effective_status")
    .eq("workspace_id", workspaceId)
    .in("meta_campaign_id", campaignIds);
  const adsets = (adsetData ?? []) as AdsetRow[];
  const adsetIds = adsets.map((a) => a.meta_adset_id);

  // 4) metrics — cumulative lifetime funnel per ad set (Σ meta_insights_daily).
  const sinceIso = new Date(nowMs - LIFETIME_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const life = new Map<string, { spend: number; impr: number; clicks: number; atc: number; purch: number; rev: number; lastDate: string | null }>();
  const acctFresh = new Map<string, { latest: string | null; updated: string | null }>();
  if (adsetIds.length) {
    const { data: ins } = await admin
      .from("meta_insights_daily")
      .select("meta_object_id, meta_ad_account_id, snapshot_date, updated_at, spend_cents, impressions, clicks, add_to_cart, purchases, revenue_cents")
      .eq("workspace_id", workspaceId)
      .eq("level", "adset")
      .in("meta_object_id", adsetIds)
      .gte("snapshot_date", sinceIso);
    for (const r of (ins ?? []) as Array<Record<string, unknown>>) {
      const k = String(r.meta_object_id);
      const cur = life.get(k) ?? { spend: 0, impr: 0, clicks: 0, atc: 0, purch: 0, rev: 0, lastDate: null };
      cur.spend += Number(r.spend_cents ?? 0);
      cur.impr += Number(r.impressions ?? 0);
      cur.clicks += Number(r.clicks ?? 0);
      cur.atc += Number(r.add_to_cart ?? 0);
      cur.purch += Number(r.purchases ?? 0);
      cur.rev += Number(r.revenue_cents ?? 0);
      const d = String(r.snapshot_date ?? "");
      if (d && (!cur.lastDate || d > cur.lastDate)) cur.lastDate = d;
      life.set(k, cur);
      // account freshness
      const acctKey = String(r.meta_ad_account_id ?? "");
      const af = acctFresh.get(acctKey) ?? { latest: null, updated: null };
      if (d && (!af.latest || d > af.latest)) af.latest = d;
      const up = r.updated_at ? String(r.updated_at) : null;
      if (up && (!af.updated || up > af.updated)) af.updated = up;
      acctFresh.set(acctKey, af);
    }
  }

  // 5) attribution + creative — ad set → product via ad_publish_jobs.campaign_id → ad_campaigns.product_id
  //    (single-cohort-product fallback). The SAME publish row carries the ad TEXT (headline / primary /
  //    description); ad_campaigns carries the rendered hero image — so the page can show a thumbnail + modal.
  const adsetToProduct = new Map<string, string>();
  const adsetToCreative = new Map<string, TestCreative>();
  if (adsetIds.length) {
    const { data: pj } = await admin
      .from("ad_publish_jobs")
      .select("meta_adset_id, campaign_id, meta_ad_id, headlines, primary_texts, description, created_at")
      .eq("workspace_id", workspaceId)
      .in("meta_adset_id", adsetIds)
      .not("campaign_id", "is", null)
      .order("created_at", { ascending: false });
    const adCampaignIds = [...new Set((pj ?? []).map((r: Record<string, unknown>) => String(r.campaign_id)).filter(Boolean))];
    const { data: ac } = await admin.from("ad_campaigns").select("id, product_id, hero_image_url").in("id", adCampaignIds.length ? adCampaignIds : ["_"]);
    const adCampaignToProduct = new Map((ac ?? []).map((r: Record<string, unknown>) => [String(r.id), r.product_id ? String(r.product_id) : null]));
    const adCampaignToImage = new Map((ac ?? []).map((r: Record<string, unknown>) => [String(r.id), r.hero_image_url ? String(r.hero_image_url) : null]));
    const first = <T,>(v: unknown): T | null => (Array.isArray(v) && v.length ? (v[0] as T) : null);
    // pj is newest-first → the FIRST row per adset is the current creative.
    for (const r of (pj ?? []) as Array<Record<string, unknown>>) {
      const adsetId = String(r.meta_adset_id);
      const campId = String(r.campaign_id);
      const prod = adCampaignToProduct.get(campId);
      if (prod && !adsetToProduct.has(adsetId)) adsetToProduct.set(adsetId, prod);
      if (!adsetToCreative.has(adsetId)) {
        adsetToCreative.set(adsetId, {
          heroImageUrl: adCampaignToImage.get(campId) ?? null,
          headline: first<string>(r.headlines),
          primaryText: first<string>(r.primary_texts),
          description: r.description ? String(r.description) : null,
          adCampaignId: campId,
          metaAdId: r.meta_ad_id ? String(r.meta_ad_id) : null,
        });
      }
    }
  }
  const soleProductForCampaign = (camp: string | null): string | null => {
    if (!camp) return null;
    const named = [...(campaignToProducts.get(camp) ?? new Set())].filter((p): p is string => !!p);
    return named.length === 1 ? named[0] : null;
  };

  // 6) build rows. Skip ad sets that never ran ($0 spend AND paused) — they aren't tests that ran,
  //    just campaign skeletons; a $0 ACTIVE ad set (just launched) is kept.
  const rows: TestAdsetRow[] = adsets.flatMap((a) => {
    const m = life.get(a.meta_adset_id) ?? { spend: 0, impr: 0, clicks: 0, atc: 0, purch: 0, rev: 0, lastDate: null };
    const status = a.effective_status ?? "UNKNOWN";
    if (m.spend === 0 && status !== "ACTIVE") return [];
    const acctRow = a.meta_campaign_id ? acctRowByCampaign.get(a.meta_campaign_id) : undefined;
    const acct = acctRow ? acctById.get(acctRow) : undefined;
    const productId = adsetToProduct.get(a.meta_adset_id) ?? soleProductForCampaign(a.meta_campaign_id) ?? null;
    return {
      productId,
      productTitle: productId ? (productTitle.get(productId) ?? productId) : "(unattributed)",
      metaAccountId: acct?.metaId ?? "",
      metaAccountName: acct?.name ?? "",
      campaignId: a.meta_campaign_id ?? "",
      adsetId: a.meta_adset_id,
      adsetName: a.name ?? "",
      effectiveStatus: status,
      active: status === "ACTIVE",
      spendCents: m.spend,
      impressions: m.impr,
      clicks: m.clicks,
      addToCart: m.atc,
      purchases: m.purch,
      revenueCents: m.rev,
      cpmCents: m.impr > 0 ? Math.round((m.spend / m.impr) * 1000) : 0,
      ctrPct: m.impr > 0 ? Number(((m.clicks / m.impr) * 100).toFixed(2)) : 0,
      costPerAtcCents: costPerAtc(m.spend, m.atc),
      cacCents: cac(m.spend, m.purch),
      tier: tierForTest({ spendCents: m.spend, purchases: m.purch, addToCart: m.atc }, thresholds),
      lastDataDate: m.lastDate,
      creative: adsetToCreative.get(a.meta_adset_id) ?? null,
    };
  });

  // 7) group by product; sort crown → dud within, best-tier products first.
  const byProduct = new Map<string, TestAdsetRow[]>();
  for (const r of rows) {
    const key = r.productId ?? `__unattr__${r.campaignId}`;
    (byProduct.get(key) ?? byProduct.set(key, []).get(key)!).push(r);
  }
  const groups: ProductTestGroup[] = [];
  for (const [, prodRows] of byProduct) {
    prodRows.sort(compareTests);
    const activeCount = prodRows.filter((r) => r.active).length;
    const first = prodRows[0];
    const flags: string[] = [];
    if (activeCount > MAX_ACTIVE_TESTS_PER_CAMPAIGN)
      flags.push(`${activeCount} active tests — exceeds the ${MAX_ACTIVE_TESTS_PER_CAMPAIGN}-concurrent cap for a product testing campaign.`);
    const campaignIdsForProduct = [...new Set(prodRows.map((r) => r.campaignId).filter(Boolean))];
    groups.push({
      productId: first.productId,
      productTitle: first.productTitle,
      metaAccountName: first.metaAccountName,
      campaignIds: campaignIdsForProduct,
      rows: prodRows,
      activeCount,
      flags,
    });
  }
  groups.sort((a, b) => {
    const at = a.rows[0] ? TIER_RANK[a.rows[0].tier] : 99;
    const bt = b.rows[0] ? TIER_RANK[b.rows[0].tier] : 99;
    if (at !== bt) return at - bt;
    const ap = a.rows.reduce((s, r) => s + r.purchases, 0);
    const bp = b.rows.reduce((s, r) => s + r.purchases, 0);
    return bp - ap;
  });

  // 8) freshness per account.
  const freshness: AccountFreshness[] = acctRowIds.map((rowId) => {
    const acct = acctById.get(rowId);
    const af = acctFresh.get(rowId) ?? { latest: null, updated: null };
    const ageHours = af.updated ? Number(((nowMs - new Date(af.updated).getTime()) / 3600000).toFixed(1)) : null;
    return { metaAccountName: acct?.name ?? rowId, metaAccountId: acct?.metaId ?? "", latestSnapshot: af.latest, lastUpdated: af.updated, ageHours };
  });

  return { generatedAt: new Date(nowMs).toISOString(), thresholds, products: groups, globalFlags, freshness };
}

/**
 * Overlay the LIVE Meta creative (image + current copy) onto each row's `creative`. The publish-row
 * snapshot is stale (copy edited on Meta after publish, and the render image, don't live in our DB) —
 * so the page shows the real thumbnail + the current headline/primary/description straight from Meta.
 * READ-ONLY Graph reads, concurrency-limited. Best-effort: an ad whose creative can't be read keeps its
 * DB snapshot. Only rows with a `creative.metaAdId` are fetched.
 */
export async function enrichWithMetaCreatives(
  rows: TestAdsetRow[],
  token: string,
  metaGraphRequest: (token: string, path: string, params?: Record<string, string>) => Promise<unknown>,
  opts: { concurrency?: number; onlyActive?: boolean } = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? 6;
  const targets = rows.filter((r) => r.creative?.metaAdId && (!opts.onlyActive || r.active));
  // De-dup by metaAdId (two rows could share an ad id in odd cases).
  const byAdId = new Map<string, TestAdsetRow[]>();
  for (const r of targets) {
    const id = r.creative!.metaAdId!;
    (byAdId.get(id) ?? byAdId.set(id, []).get(id)!).push(r);
  }
  const adIds = [...byAdId.keys()];

  const fetchOne = async (adId: string): Promise<void> => {
    try {
      const res = (await metaGraphRequest(token, `/${adId}`, {
        fields: "creative{thumbnail_url,image_url,object_story_spec}",
      })) as { creative?: { thumbnail_url?: string; image_url?: string; object_story_spec?: { link_data?: { message?: string; name?: string; description?: string; link?: string } } } };
      const c = res.creative;
      if (!c) return;
      const ld = c.object_story_spec?.link_data;
      for (const r of byAdId.get(adId) ?? []) {
        const cr = r.creative!;
        cr.thumbnailUrl = c.thumbnail_url ?? null;
        cr.imageUrl = c.image_url ?? c.thumbnail_url ?? null;
        if (ld?.name) cr.headline = ld.name;
        if (ld?.message) cr.primaryText = ld.message;
        if (ld?.description) cr.description = ld.description;
        if (ld?.link) cr.link = ld.link;
        cr.metaEnriched = true;
      }
    } catch {
      /* keep the DB snapshot for this ad */
    }
  };

  // Simple concurrency pool.
  for (let i = 0; i < adIds.length; i += concurrency) {
    await Promise.all(adIds.slice(i, i + concurrency).map(fetchOne));
  }
}

/** Crown → dud comparator: by tier, then purchases desc, then CAC asc, then cost-per-ATC asc, then CTR desc. */
export function compareTests(a: TestAdsetRow, b: TestAdsetRow): number {
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (a.purchases !== b.purchases) return b.purchases - a.purchases;
  const ac = a.cacCents ?? Number.MAX_SAFE_INTEGER;
  const bc = b.cacCents ?? Number.MAX_SAFE_INTEGER;
  if (ac !== bc) return ac - bc;
  const aa = a.costPerAtcCents ?? Number.MAX_SAFE_INTEGER;
  const ba = b.costPerAtcCents ?? Number.MAX_SAFE_INTEGER;
  if (aa !== ba) return aa - ba;
  return b.ctrPct - a.ctrPct;
}
