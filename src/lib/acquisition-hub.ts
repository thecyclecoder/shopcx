/**
 * Acquisition Research Hub — the aggregation + routing layer behind one owner surface
 * (docs/brain/specs/acquisition-research-hub.md, Phase 1; M4 of docs/brain/goals/acquisition-research-engine.md).
 *
 * Houses the whole Acquisition Research Engine in one place: the competitor sets (competitor-scout),
 * both scouts' findings (ad-creative-scout + landing-page-scout), and a UNIFIED gap queue where the
 * owner approves → routes a gap to Build (a component / ad-creative iteration) or the storefront
 * optimizer (an experiment), tracked through to shipped/won.
 *
 * The two scouts persist their gaps differently: lander gaps already live in `lander_recommendations`
 * (the Landing Page Scout writes them). Ad gaps are computed DETERMINISTICALLY ON DEMAND by
 * `buildAdGapReport` and were never persisted — so this module MATERIALIZES them into
 * `ad_gap_recommendations` (idempotent on dedup_key, always 'proposed') before merging the two sources
 * into one queue. Throughput (proposed → shipped → won) is DERIVED by joining each approved gap's route
 * artifact (agent_jobs for a Build, storefront_experiments for an optimizer experiment) — no extra
 * status columns to drift.
 *
 * North-star (docs/brain/operational-rules.md § North star): the scouts PROPOSE gaps with evidence;
 * the owner (later the Growth director) approves what routes. Nothing here auto-routes.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAdGapReport, type AdGapReport, type AdGapRecommendation } from "@/lib/ad-gap";
import {
  loadSuppressedGapTypes,
  isSuppressed,
  loadGapTypeGradeSignal,
  type GapTypeGradeSignal,
} from "@/lib/acquisition-gap-grader";

// ── Normalized gap-queue item (the union of an ad gap and a lander gap) ──────────
export type GapSource = "ad" | "lander";
export type GapRoute = "build" | "optimizer";
export type GapStatus = "proposed" | "approved" | "rejected";

export interface GapQueueItem {
  id: string;
  source: GapSource;
  product_id: string | null;
  product_title: string | null;
  gap_type: string;
  title: string;
  rationale: string;
  route: GapRoute;
  status: GapStatus;
  route_result: Record<string, unknown> | null;
  /** Derived from the route artifact: a Build PR is open, or the experiment has launched. */
  shipped: boolean;
  /** Derived: the routed experiment was promoted (a validated win). */
  won: boolean;
  evidence: Record<string, unknown>;
  created_at: string;
  /** The Growth-director gap→outcome grade (M5 loop), null until the gap is acted-on + graded. */
  grade: GapGradeSummary | null;
}

/** The grade attached to an acted-on gap (from acquisition_gap_grades). */
export interface GapGradeSummary {
  grade_id: string;
  grade_initial: number | null;
  grade_revised: number | null;
  gap_quality: number | null;
  outcome_quality: number | null;
  outcome_state: string;
  graded_by: string;
}

export interface GapThroughput {
  proposed: number;
  approved: number;
  shipped: number;
  won: number;
}

export interface CompetitorRow {
  id: string;
  product_id: string | null;
  brand: string;
  domain: string | null;
  pdp_urls: string[] | null;
  category: string | null;
  spend_signal: string | null;
  source: string;
  status: string;
  evidence: Record<string, unknown> | null;
  /**
   * `source='whitelisted'` rows only: the exact AdLibrary page name the sweep searches (verbatim).
   * Null for real brand competitors (they fall back to `brand`).
   */
  search_keyword: string | null;
  /** `source='whitelisted'` rows only: the fronted competitor's id (self-FK). */
  runs_ads_for: string | null;
  /**
   * Server-resolved display brand for `runs_ads_for` — so the UI can render "runs ads for {brand}"
   * without a second lookup. Null when the row isn't whitelisted / the fronted row is missing.
   */
  runs_ads_for_brand: string | null;
}

export interface LanderSnapshotRow {
  id: string;
  product_id: string | null;
  competitor_id: string | null;
  is_ours: boolean;
  brand: string | null;
  url: string;
  source: string;
  status: string;
  chapter_count: number;
  captured_at: string | null;
}

export interface HubProduct {
  id: string;
  title: string | null;
}

export interface HubData {
  products: HubProduct[];
  selectedProductId: string | null;
  competitors: CompetitorRow[];
  adFindings: AdGapReport;
  landerSnapshots: LanderSnapshotRow[];
  gapQueue: GapQueueItem[];
  throughput: GapThroughput;
  /** The M5 grading loop's training signal: per-gap_type avg grades + the overall average. */
  gradeSignal: GapTypeGradeSignal;
  /** `${source}:${gap_type}` keys currently down-weighted (suppressed from re-surfacing). */
  suppressedTypes: string[];
}

/** Slug-safe handle for an ad-angle label (dedup + target spec slug). */
function slugifyAngle(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "angle"
  );
}

const adDedupKey = (label: string) => `ad-angle:${slugifyAngle(label)}`;

/** Map an AdGapRecommendation to the evidence blob persisted on the row. */
function adEvidence(rec: AdGapRecommendation): Record<string, unknown> {
  return {
    brandCount: rec.brandCount,
    brands: rec.brands,
    maxDaysRunning: rec.maxDaysRunning,
    totalEstimatedSpend: rec.totalEstimatedSpend,
    formats: rec.formats,
    offers: rec.offers,
    ctas: rec.ctas,
    ads: rec.evidence,
  };
}

/**
 * Materialize the (deterministic) ad-gap report into `ad_gap_recommendations` as 'proposed' rows.
 * Idempotent: inserts only NEW dedup_keys (ignoreDuplicates) so an already-approved/rejected angle
 * is never reset to proposed and a re-run never duplicates. Returns the live report for display.
 */
export async function materializeAdGaps(
  workspaceId: string,
  opts: { minBrands?: number; minDaysRunning?: number } = {},
): Promise<AdGapReport> {
  const report = await buildAdGapReport(workspaceId, opts);
  if (report.recommendations.length === 0) return report;

  const admin = createAdminClient();

  // The loop's training feedback: if the Growth-director grade has down-weighted the ad-angle gap
  // type (consistently rejected / lost), STOP re-surfacing new ad-angle gaps — the loop learns
  // (docs/brain/specs/acquisition-research-loop-grading.md, Phase 1). The report still renders for
  // transparency; we just don't materialize new 'proposed' rows for a suppressed type.
  const suppressed = await loadSuppressedGapTypes({ workspaceId, admin });
  if (isSuppressed(suppressed, "ad", "ad_angle")) return report;

  const rows = report.recommendations.map((rec) => ({
    workspace_id: workspaceId,
    gap_type: "ad_angle",
    title: rec.label,
    rationale: rec.recommendation,
    route: "build" as const,
    target_slug: `ad-angle-${slugifyAngle(rec.label)}`,
    evidence: adEvidence(rec),
    status: "proposed" as const,
    dedup_key: adDedupKey(rec.label),
  }));

  // Insert only angles we haven't seen — never clobber a settled (approved/rejected) row.
  await admin.from("ad_gap_recommendations").upsert(rows, {
    onConflict: "workspace_id,dedup_key",
    ignoreDuplicates: true,
  });
  return report;
}

// ── Routing an approved AD gap (mirrors landing-page-scout's enactRecommendationRoute) ──
interface AdGapRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  gap_type: string;
  title: string;
  rationale: string;
  route: GapRoute;
  target_slug: string | null;
  evidence: Record<string, unknown> | null;
}
interface EnactResult {
  ok: boolean;
  error?: string;
  route_result?: Record<string, unknown>;
}

/**
 * Enact an approved ad gap's route. Ad gaps go to 'build' — author + build an ad-creative iteration
 * exploring the competitor angle we don't run (the ad iteration engine). Mirrors the Landing Page
 * Scout's build route: an `agent_jobs` build keyed on the ad-iteration spec slug.
 */
export async function enactAdGapRoute(rec: AdGapRow, userId: string | null): Promise<EnactResult> {
  const admin = createAdminClient();

  // Ad gaps only ever route to Build in Phase 1; 'optimizer' is reserved for forward-symmetry.
  if (rec.route !== "build") {
    return { ok: false, error: `ad gaps route to 'build', not '${rec.route}'` };
  }

  const slug = rec.target_slug || `ad-angle-${slugifyAngle(rec.title)}`;
  const instructions = JSON.stringify({
    source: "ad-creative-scout",
    gap_type: rec.gap_type,
    title: rec.title,
    rationale: rec.rationale,
    recommendation_id: rec.id,
    evidence: rec.evidence,
    note: "Author + build an ad-creative iteration exploring this competitor angle we don't run, then route it into the ad iteration engine.",
  });
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: rec.workspace_id,
      spec_slug: slug,
      kind: "build",
      status: "queued",
      instructions,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, route_result: { agent_job_id: data.id, spec_slug: slug } };
}

// ── Throughput: derive shipped/won from each approved gap's route artifact ───────
async function deriveArtifactState(
  items: { route_result: Record<string, unknown> | null }[],
): Promise<{ jobShipped: Set<string>; expLaunched: Set<string>; expWon: Set<string> }> {
  const admin = createAdminClient();
  const jobIds = new Set<string>();
  const expIds = new Set<string>();
  for (const it of items) {
    const rr = it.route_result || {};
    if (typeof rr.agent_job_id === "string") jobIds.add(rr.agent_job_id);
    if (typeof rr.experiment_id === "string") expIds.add(rr.experiment_id);
  }

  const jobShipped = new Set<string>();
  if (jobIds.size > 0) {
    const { data } = await admin.from("agent_jobs").select("id, status").in("id", [...jobIds]);
    // "Shipped" = the Build delivered a PR (status completed) — the work is in review/merged.
    for (const j of data || []) if (j.status === "completed") jobShipped.add(j.id as string);
  }

  const expLaunched = new Set<string>();
  const expWon = new Set<string>();
  if (expIds.size > 0) {
    const { data } = await admin.from("storefront_experiments").select("id, status").in("id", [...expIds]);
    for (const e of data || []) {
      // Launched = anything past 'draft'; won = the bandit promoted the variant.
      if (e.status !== "draft") expLaunched.add(e.id as string);
      if (e.status === "promoted") expWon.add(e.id as string);
    }
  }
  return { jobShipped, expLaunched, expWon };
}

function gapShippedWon(
  item: { route_result: Record<string, unknown> | null; status: GapStatus },
  state: { jobShipped: Set<string>; expLaunched: Set<string>; expWon: Set<string> },
): { shipped: boolean; won: boolean } {
  if (item.status !== "approved" || !item.route_result) return { shipped: false, won: false };
  const rr = item.route_result;
  const jobId = typeof rr.agent_job_id === "string" ? rr.agent_job_id : null;
  const expId = typeof rr.experiment_id === "string" ? rr.experiment_id : null;
  const shipped = (jobId ? state.jobShipped.has(jobId) : false) || (expId ? state.expLaunched.has(expId) : false);
  const won = expId ? state.expWon.has(expId) : false;
  return { shipped, won };
}

/**
 * Load the whole hub payload for a workspace (optionally scoped to a product). Materializes the
 * current ad gaps first, then aggregates competitors + both scouts' findings + the unified gap queue
 * + the derived throughput. Read-only apart from the idempotent ad-gap materialization.
 */
export async function loadHubData(workspaceId: string, productId?: string | null): Promise<HubData> {
  const admin = createAdminClient();

  // Materialize ad gaps so they have stable IDs + a lifecycle (idempotent, deterministic).
  const adFindings = await materializeAdGaps(workspaceId);

  // Products for the selector.
  const { data: productRows } = await admin
    .from("products")
    .select("id, title")
    .eq("workspace_id", workspaceId)
    .order("title", { ascending: true });
  const products: HubProduct[] = (productRows || []).map((p) => ({ id: p.id as string, title: p.title as string | null }));
  const productTitle = new Map(products.map((p) => [p.id, p.title]));
  const selectedProductId = productId && products.some((p) => p.id === productId) ? productId : null;

  // Competitor set (scoped to the product when one is selected).
  let competitorsQ = admin
    .from("competitors")
    .select(
      "id, product_id, brand, domain, pdp_urls, category, spend_signal, source, status, evidence, search_keyword, runs_ads_for",
    )
    .eq("workspace_id", workspaceId)
    .order("status", { ascending: true })
    .order("brand", { ascending: true });
  if (selectedProductId) competitorsQ = competitorsQ.eq("product_id", selectedProductId);
  const { data: compRows } = await competitorsQ;
  // The `runs_ads_for` self-FK can point at ANY competitor in the workspace, incl. rows filtered
  // out by the product scope. Resolve via a separate id→brand fetch so a product-scoped view still
  // shows "runs ads for <brand>" for its whitelisted rows.
  const runsAdsForIds = Array.from(
    new Set((compRows || []).map((r) => r.runs_ads_for as string | null).filter((v): v is string => !!v)),
  );
  const compIdToBrand = new Map<string, string>();
  if (runsAdsForIds.length) {
    const { data: fronted } = await admin
      .from("competitors")
      .select("id, brand")
      .eq("workspace_id", workspaceId)
      .in("id", runsAdsForIds);
    for (const r of fronted || []) compIdToBrand.set(r.id as string, (r.brand as string) || "");
  }
  const competitors: CompetitorRow[] = (compRows || []).map((r) => ({
    id: r.id as string,
    product_id: r.product_id as string | null,
    brand: r.brand as string,
    domain: r.domain as string | null,
    pdp_urls: r.pdp_urls as string[] | null,
    category: r.category as string | null,
    spend_signal: r.spend_signal as string | null,
    source: r.source as string,
    status: r.status as string,
    evidence: r.evidence as Record<string, unknown> | null,
    search_keyword: (r.search_keyword as string | null) ?? null,
    runs_ads_for: (r.runs_ads_for as string | null) ?? null,
    runs_ads_for_brand: r.runs_ads_for ? compIdToBrand.get(r.runs_ads_for as string) || null : null,
  }));

  // Lander findings — snapshots (light: brand/url/status, no signed images here).
  let snapsQ = admin
    .from("lander_snapshots")
    .select("id, product_id, competitor_id, is_ours, brand, url, source, status, chapters, captured_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(60);
  if (selectedProductId) snapsQ = snapsQ.eq("product_id", selectedProductId);
  const { data: snapRows } = await snapsQ;
  const landerSnapshots: LanderSnapshotRow[] = (snapRows || []).map((s) => ({
    id: s.id as string,
    product_id: s.product_id as string | null,
    competitor_id: s.competitor_id as string | null,
    is_ours: s.is_ours as boolean,
    brand: s.brand as string | null,
    url: s.url as string,
    source: s.source as string,
    status: s.status as string,
    chapter_count: Array.isArray(s.chapters) ? s.chapters.length : 0,
    captured_at: s.captured_at as string | null,
  }));

  // ── The unified gap queue: ad gaps + lander gaps ──
  const { data: adGapRows } = await admin
    .from("ad_gap_recommendations")
    .select("id, product_id, gap_type, title, rationale, route, status, route_result, evidence, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  let landerRecsQ = admin
    .from("lander_recommendations")
    .select("id, product_id, gap_type, title, rationale, route, status, route_result, evidence, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (selectedProductId) landerRecsQ = landerRecsQ.eq("product_id", selectedProductId);
  const { data: landerRecRows } = await landerRecsQ;

  const rawQueue = [
    ...(adGapRows || []).map((r) => ({ ...r, source: "ad" as GapSource })),
    ...(landerRecRows || []).map((r) => ({ ...r, source: "lander" as GapSource })),
  ];

  const artifactState = await deriveArtifactState(
    rawQueue.map((r) => ({ route_result: (r.route_result as Record<string, unknown> | null) ?? null })),
  );

  // Attach the M5 gap→outcome grades (keyed by `${source}:${gap_id}`) so the grade history is visible.
  const { data: gradeRows } = await admin
    .from("acquisition_gap_grades")
    .select("id, gap_source, gap_id, grade_initial, grade_revised, gap_quality, outcome_quality, outcome_state, graded_by")
    .eq("workspace_id", workspaceId);
  const gradeByGap = new Map<string, GapGradeSummary>();
  for (const gr of gradeRows || []) {
    gradeByGap.set(`${gr.gap_source}:${gr.gap_id}`, {
      grade_id: gr.id as string,
      grade_initial: (gr.grade_initial as number | null) ?? null,
      grade_revised: (gr.grade_revised as number | null) ?? null,
      gap_quality: (gr.gap_quality as number | null) ?? null,
      outcome_quality: (gr.outcome_quality as number | null) ?? null,
      outcome_state: gr.outcome_state as string,
      graded_by: gr.graded_by as string,
    });
  }

  const gapQueue: GapQueueItem[] = rawQueue
    .map((r) => {
      const item = {
        route_result: (r.route_result as Record<string, unknown> | null) ?? null,
        status: r.status as GapStatus,
      };
      const { shipped, won } = gapShippedWon(item, artifactState);
      return {
        id: r.id as string,
        source: r.source,
        product_id: (r.product_id as string | null) ?? null,
        product_title: r.product_id ? productTitle.get(r.product_id as string) ?? null : null,
        gap_type: r.gap_type as string,
        title: r.title as string,
        rationale: r.rationale as string,
        route: r.route as GapRoute,
        status: r.status as GapStatus,
        route_result: item.route_result,
        shipped,
        won,
        evidence: (r.evidence as Record<string, unknown> | null) ?? {},
        created_at: r.created_at as string,
        grade: gradeByGap.get(`${r.source}:${r.id as string}`) ?? null,
      };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const throughput: GapThroughput = {
    proposed: gapQueue.filter((g) => g.status === "proposed").length,
    approved: gapQueue.filter((g) => g.status === "approved").length,
    shipped: gapQueue.filter((g) => g.shipped).length,
    won: gapQueue.filter((g) => g.won).length,
  };

  const gradeSignal = await loadGapTypeGradeSignal({ workspaceId, admin });
  const suppressedTypes = [...(await loadSuppressedGapTypes({ workspaceId, admin }))];

  return {
    products,
    selectedProductId,
    competitors,
    adFindings,
    landerSnapshots,
    gapQueue,
    throughput,
    gradeSignal,
    suppressedTypes,
  };
}
