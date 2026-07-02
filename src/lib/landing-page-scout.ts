/**
 * Landing Page Scout — per-chapter lander snapshots + vision gap-analysis (docs/brain/specs/landing-page-scout.md).
 *
 * M3 of the Acquisition Research Engine. Snapshots competitor landing pages AND ours, mobile, broken
 * into chapters, then vision-analyzes the GAPS → PDP enhancement recommendations.
 *
 * North-star (supervisable autonomy): the vision pass only ever writes lander_recommendations with
 * status='proposed' WITH evidence; an owner approves before anything routes to Build (a missing
 * component spec) or the storefront-optimizer (a structural experiment). The proxy (competitor
 * structure) is bounded; the owner owns the objective.
 *
 * The HEADLESS-BROWSER capture itself is a box script (scripts/landing-page-snapshot.ts) — Playwright
 * can't run in serverless. This module owns the parts that DO run in serverless / Inngest:
 *   - loadLanderTargets()  — sources competitor lander URLs (competitor-scout PDP URLs + ad-creative-scout
 *                            ad destinations) + our own landers; the script reads this to know what to shoot.
 *   - loadChapterStats()   — per-chapter funnel stats (dwell %, view→CTA %) from storefront_events
 *                            (StorefrontChapterTracker), paired into our snapshot's chapters.
 *   - analyzeLanderGaps()  — the vision gap-analysis pass → proposed lander_recommendations.
 *   - enactRecommendationRoute() — what an APPROVED recommendation does (build job / optimizer draft).
 *   - storage helpers      — the private `lander-shots` bucket (per-chapter screenshots, signed URLs).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { loadSuppressedGapTypes, isSuppressed } from "@/lib/acquisition-gap-grader";

export const LANDER_SHOTS_BUCKET = "lander-shots";
export const SIGNED_TTL_SEC = 3600; // 1 hour — comfortably longer than any analysis pass

// ── Storage (private bucket; UI reads via short-lived signed URLs) ──────────────

/** Ensure the private screenshot bucket exists (idempotent — also done by the apply script). */
export async function ensureLanderShotsBucket(): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(LANDER_SHOTS_BUCKET);
  if (!data) await admin.storage.createBucket(LANDER_SHOTS_BUCKET, { public: false });
}

/** Upload a per-chapter screenshot buffer to the private bucket. Returns the stored path. */
export async function uploadLanderShot(path: string, buffer: Buffer, contentType = "image/png"): Promise<string> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(LANDER_SHOTS_BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`lander_shot_upload: ${error.message}`);
  return path;
}

/** Short-lived signed URL for a stored chapter screenshot (UI previews + the vision fetch). */
export async function signLanderShot(path: string, ttlSec = SIGNED_TTL_SEC): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(LANDER_SHOTS_BUCKET).createSignedUrl(path, ttlSec);
  return error || !data ? null : data.signedUrl;
}

// ── Sourcing the landers (the bridge) ───────────────────────────────────────────

export type LanderTargetSource = "ad_destination" | "competitor_pdp" | "our_lander";

export interface LanderTarget {
  url: string;
  source: LanderTargetSource;
  is_ours: boolean;
  brand: string | null;
  competitor_id: string | null;
  product_id: string | null;
}

interface CompetitorTargetRow {
  id: string;
  brand: string;
  domain: string | null;
  pdp_urls: string[] | null;
  product_id: string | null;
}

/**
 * Best-effort ad-destination extraction from a brand's captured AdLibrary rows (ad-creative-scout).
 * The "exact page competitors spend to drive paid traffic to" is the highest-signal lander. Today the
 * AdLibrary `raw` payload rarely carries a destination URL, so this scans `raw` for a landing/link URL
 * and returns whatever it finds (often empty) — it lights up automatically once ad-creative-scout
 * captures destinations. We never invent a URL; competitor-scout PDP URLs are the reliable bridge.
 */
async function adDestinationsForBrand(workspaceId: string, brand: string): Promise<string[]> {
  const admin = createAdminClient();
  // Match on `seed_keyword` (the normalized keyword the sweep ran, == competitors.brand) — NOT
  // `advertiser`, which is the display name ("Erth Labs" ≠ "erthlabs") and matched nothing. Read the
  // `destination_domain` COLUMN ([[adlibrary]] normalizes it from ecom_advertiser_id) — it's now
  // reliably captured, so we no longer scrape `raw`. Rank by frequency: the most-run destination is
  // the real lander (Erth: learn.erthlabs.co ×21 beats erthlabs.co ×6).
  const { data } = await admin
    .from("creative_skeletons")
    .select("landing_page_url, destination_domain")
    .eq("workspace_id", workspaceId)
    .eq("seed_keyword", brand)
    .limit(500);
  // PREFER the full landing_page_url (the real advertorial WITH path, e.g. …/women50) over the bare
  // domain — the domain root often 404s. Count both, but full URLs sort ahead of domain fallbacks.
  const fullUrls = new Map<string, number>();
  const domains = new Map<string, number>();
  for (const r of data || []) {
    const lp = (r.landing_page_url as string | null)?.trim();
    if (lp && /^https?:\/\//i.test(lp)) {
      fullUrls.set(lp, (fullUrls.get(lp) ?? 0) + 1);
      continue;
    }
    const d = (r.destination_domain as string | null)?.replace(/^https?:\/\//i, "").trim();
    if (d) domains.set(d, (domains.get(d) ?? 0) + 1);
  }
  const rankedFull = [...fullUrls.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const rankedDomains = [...domains.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => `https://${d}`);
  return [...rankedFull, ...rankedDomains].slice(0, 3);
}

/** Public URL for one of OUR storefront landers (mirrors /api/ads/landers landerUrl). */
function ourLanderUrl(domain: string | null, slug: string | null, handle: string): string | null {
  if (!handle) return null;
  if (domain) return `https://${domain}/${handle}`;
  if (slug) return `https://shopcx.ai/store/${slug}/${handle}`;
  return null;
}

/**
 * The capture pipeline's read path: every lander URL to snapshot for a workspace (optionally one
 * product). Competitor targets = ad-creative-scout ad destinations (highest signal) + competitor-scout
 * canonical PDP URLs (breadth). Our targets = our storefront PDP for the product(s) in scope.
 */
export async function loadLanderTargets(workspaceId: string, productId?: string | null): Promise<LanderTarget[]> {
  const admin = createAdminClient();
  const targets: LanderTarget[] = [];

  // Competitor landers — approved competitors only (supervisable; never the proposed set).
  let cq = admin
    .from("competitors")
    .select("id, brand, domain, pdp_urls, product_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved");
  if (productId) cq = cq.or(`product_id.eq.${productId},product_id.is.null`);
  const { data: competitors } = await cq;

  for (const c of (competitors || []) as CompetitorTargetRow[]) {
    const seen = new Set<string>();
    const push = (url: string, source: LanderTargetSource) => {
      const u = (url || "").trim();
      if (!u || seen.has(u)) return;
      seen.add(u);
      targets.push({ url: u, source, is_ours: false, brand: c.brand, competitor_id: c.id, product_id: c.product_id ?? productId ?? null });
    };
    for (const dest of await adDestinationsForBrand(workspaceId, c.brand)) push(dest, "ad_destination");
    for (const pdp of c.pdp_urls || []) push(pdp, "competitor_pdp");
    // Fall back to the brand homepage only if we have no PDP/destination at all.
    if (seen.size === 0 && c.domain) push(`https://${c.domain.replace(/^https?:\/\//, "")}`, "competitor_pdp");
  }

  // Our landers — the storefront PDP for the product(s) in scope.
  const { data: ws } = await admin
    .from("workspaces")
    .select("storefront_domain, storefront_slug")
    .eq("id", workspaceId)
    .maybeSingle();
  let pq = admin.from("products").select("id, handle").eq("workspace_id", workspaceId);
  if (productId) pq = pq.eq("id", productId);
  const { data: products } = await pq;
  for (const p of (products || []) as Array<{ id: string; handle: string | null }>) {
    const url = ourLanderUrl(ws?.storefront_domain || null, ws?.storefront_slug || null, p.handle || "");
    if (url) targets.push({ url, source: "our_lander", is_ours: true, brand: "us", competitor_id: null, product_id: p.id });
  }

  return targets;
}

// ── Our per-chapter funnel stats (StorefrontChapterTracker → storefront_events) ──

export interface ChapterStat {
  chapter: string;
  reach_sessions: number;
  avg_dwell_ms: number;
  view_to_cta_pct: number;
}

/**
 * Per-chapter funnel stats for OUR lander over the last `days` — so each of our chapter shots pairs
 * with that chapter's effectiveness. Reads chapter_view / chapter_dwell / cta_click from
 * storefront_events (emitted by StorefrontChapterTracker). Keyed by chapter label.
 */
export async function loadChapterStats(
  workspaceId: string,
  productId?: string | null,
  days = 30,
): Promise<Record<string, ChapterStat>> {
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let q = admin
    .from("storefront_events")
    .select("event_type, session_id, meta")
    .eq("workspace_id", workspaceId)
    .in("event_type", ["chapter_view", "chapter_dwell", "cta_click"])
    .gte("created_at", sinceIso)
    .limit(50000);
  if (productId) q = q.eq("product_id", productId);
  const { data } = await q;

  const viewSessions = new Map<string, Set<string>>();
  const ctaSessions = new Map<string, Set<string>>();
  const dwell = new Map<string, { ms: number; n: number }>();

  for (const e of data || []) {
    const meta = (e.meta || {}) as { chapter?: string; dwell_ms?: number };
    const chapter = meta.chapter;
    if (!chapter) continue;
    const sid = String(e.session_id);
    if (e.event_type === "chapter_view") {
      if (!viewSessions.has(chapter)) viewSessions.set(chapter, new Set());
      viewSessions.get(chapter)!.add(sid);
    } else if (e.event_type === "cta_click") {
      if (!ctaSessions.has(chapter)) ctaSessions.set(chapter, new Set());
      ctaSessions.get(chapter)!.add(sid);
    } else if (e.event_type === "chapter_dwell" && typeof meta.dwell_ms === "number") {
      const cur = dwell.get(chapter) || { ms: 0, n: 0 };
      cur.ms += meta.dwell_ms;
      cur.n += 1;
      dwell.set(chapter, cur);
    }
  }

  const totalSessions = new Set<string>();
  for (const set of viewSessions.values()) for (const s of set) totalSessions.add(s);
  const denom = totalSessions.size;

  const out: Record<string, ChapterStat> = {};
  for (const chapter of viewSessions.keys()) {
    const reach = viewSessions.get(chapter)?.size || 0;
    const cta = ctaSessions.get(chapter)?.size || 0;
    const d = dwell.get(chapter);
    out[chapter] = {
      chapter,
      reach_sessions: reach,
      avg_dwell_ms: d && d.n > 0 ? Math.round(d.ms / d.n) : 0,
      view_to_cta_pct: reach > 0 ? Math.round((cta / reach) * 1000) / 10 : 0,
    };
  }
  // Expose reach as a % of top-of-funnel via the unused denom guard (kept for parity with the funnel route).
  void denom;
  return out;
}

// ── Vision gap-analysis ─────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  product_id: string | null;
  competitor_id: string | null;
  is_ours: boolean;
  brand: string | null;
  url: string;
  status: string;
  chapters: Array<{ index?: number; label?: string; screenshot_path?: string }> | null;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

const GAP_SYSTEM = `You are a DTC conversion-rate strategist comparing competitor mobile landing pages against OURS, chapter by chapter (a "chapter" is a scrollable page section).

You are given per-chapter screenshots labelled COMPETITOR <brand> #<i> or OURS #<i>. Identify the structural GAPS: sections, proof elements, structure, or offers that MULTIPLE competitors show but OURS lacks (comparison table, founder story, ingredient breakdown, guarantee/clinical badges, above-the-fold offer, social-proof wall, etc.).

For EACH real gap return:
- "gap_type": a short snake_case handle (e.g. "comparison_table", "founder_story", "ingredient_breakdown", "guarantee_badges", "above_fold_offer").
- "title": a one-line name for the enhancement.
- "rationale": ONE concrete sentence citing how many competitors show it and that we don't (e.g. "3 of 4 competitors show a comparison table above the fold; ours has none").
- "route": "build" if shipping it needs a NEW page component we don't have; "optimizer" if it's a structural rearrange/copy change we can already A/B test.
- "target_slug": for route="build" ONLY, a kebab-case spec slug for the new component (e.g. "pdp-comparison-table"). Omit for "optimizer".

Only report gaps backed by ≥2 competitors. Return ONLY a JSON array, no prose, no markdown fences:
[{"gap_type":"...","title":"...","rationale":"...","route":"build|optimizer","target_slug":"..."}]`;

interface VisionGap {
  gap_type: string;
  title: string;
  rationale: string;
  route: "build" | "optimizer";
  target_slug?: string;
}

async function fetchAsBase64(url: string): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mediaType: ct.split(";")[0] };
  } catch {
    return null;
  }
}

export interface AnalyzeResult {
  proposed: number;
  skippedExisting: number;
  /** Gaps NOT surfaced because their gap_type was down-weighted by the gap-grade loop. */
  skippedSuppressed: number;
  competitorSnapshots: number;
  ourSnapshots: number;
  gaps: number;
  skipped?: string;
}

/**
 * Vision gap-analysis for a workspace (optionally one product): compare the latest captured competitor
 * lander snapshots against ours, chapter by chapter, and write proposed lander_recommendations. Bounded
 * cost: up to 4 competitors × 6 chapters + our 8 chapters. Blocked/failed snapshots are skipped, never
 * fatal. Deduped on (workspace_id, dedup_key) so re-runs don't re-propose a gap.
 */
export async function analyzeLanderGaps(workspaceId: string, productId?: string | null): Promise<AnalyzeResult> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  const admin = createAdminClient();

  const loadLatest = async (isOurs: boolean): Promise<SnapshotRow[]> => {
    let q = admin
      .from("lander_snapshots")
      .select("id, product_id, competitor_id, is_ours, brand, url, status, chapters")
      .eq("workspace_id", workspaceId)
      .eq("is_ours", isOurs)
      .eq("status", "captured")
      .order("created_at", { ascending: false })
      .limit(isOurs ? 1 : 6);
    if (productId) q = q.eq("product_id", productId);
    const { data } = await q;
    return (data || []) as SnapshotRow[];
  };

  const competitorSnaps = await loadLatest(false);
  const ourSnaps = await loadLatest(true);

  if (!competitorSnaps.length || !ourSnaps.length) {
    return {
      proposed: 0,
      skippedExisting: 0,
      skippedSuppressed: 0,
      competitorSnapshots: competitorSnaps.length,
      ourSnapshots: ourSnaps.length,
      gaps: 0,
      skipped: "need at least one captured competitor snapshot AND our snapshot",
    };
  }

  // Build the interleaved vision message: labelled chapter shots for competitors + ours.
  const content: Array<Record<string, unknown>> = [];
  const addChapters = async (snap: SnapshotRow, label: string, maxChapters: number) => {
    const chapters = (snap.chapters || []).slice(0, maxChapters);
    for (const ch of chapters) {
      if (!ch.screenshot_path) continue;
      const signed = await signLanderShot(ch.screenshot_path);
      if (!signed) continue;
      const img = await fetchAsBase64(signed);
      if (!img) continue;
      content.push({ type: "text", text: `${label} #${ch.index ?? "?"}${ch.label ? ` (${ch.label})` : ""}` });
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
  };

  for (const snap of competitorSnaps.slice(0, 4)) {
    await addChapters(snap, `COMPETITOR ${snap.brand || "?"}`, 6);
  }
  await addChapters(ourSnaps[0], "OURS", 8);
  content.push({ type: "text", text: "Identify the structural gaps competitors have that ours lacks. Return the JSON array." });

  if (content.filter((c) => c.type === "image").length === 0) {
    return {
      proposed: 0,
      skippedExisting: 0,
      skippedSuppressed: 0,
      competitorSnapshots: competitorSnaps.length,
      ourSnapshots: ourSnaps.length,
      gaps: 0,
      skipped: "no readable chapter screenshots in the captured snapshots",
    };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 2000,
      system: GAP_SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`vision_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as AnthropicResponse;
  await logAiUsage({
    workspaceId,
    model: OPUS_MODEL,
    usage: json.usage || {},
    purpose: "landing-page-scout-gap-analysis",
  }).catch(() => {});

  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
  const gaps = parseGaps(text);

  const competitorSnapshotIds = competitorSnaps.map((s) => s.id);
  const result: AnalyzeResult = {
    proposed: 0,
    skippedExisting: 0,
    skippedSuppressed: 0,
    competitorSnapshots: competitorSnaps.length,
    ourSnapshots: ourSnaps.length,
    gaps: gaps.length,
  };

  // The loop's training feedback: skip gap types the Growth-director grade has down-weighted
  // (consistently rejected / lost) so we don't endlessly re-surface them — the loop learns
  // (docs/brain/specs/acquisition-research-loop-grading.md, Phase 1).
  const suppressed = await loadSuppressedGapTypes({ workspaceId, admin });

  for (const g of gaps) {
    if (isSuppressed(suppressed, "lander", g.gap_type)) {
      result.skippedSuppressed++;
      continue;
    }
    const dedupKey = `${productId || "ws"}:${g.gap_type}`;
    const { data: existing } = await admin
      .from("lander_recommendations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("dedup_key", dedupKey)
      .maybeSingle();
    if (existing) {
      result.skippedExisting++;
      continue;
    }
    const { error } = await admin.from("lander_recommendations").insert({
      workspace_id: workspaceId,
      product_id: productId ?? null,
      gap_type: g.gap_type,
      title: g.title,
      rationale: g.rationale,
      route: g.route,
      target_slug: g.route === "build" ? g.target_slug || `pdp-${g.gap_type.replace(/_/g, "-")}` : null,
      evidence: {
        competitor_snapshot_ids: competitorSnapshotIds,
        competitor_count: competitorSnaps.length,
        our_snapshot_id: ourSnaps[0].id,
      },
      status: "proposed",
      dedup_key: dedupKey,
    });
    if (!error) result.proposed++;
    else result.skippedExisting++;
  }

  return result;
}

function parseGaps(text: string): VisionGap[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as VisionGap[];
    return Array.isArray(arr)
      ? arr
          .filter((g) => g && g.gap_type && g.title && g.rationale && (g.route === "build" || g.route === "optimizer"))
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

// ── Routing an APPROVED recommendation (supervisable: only ever after owner approval) ──

export interface EnactResult {
  ok: boolean;
  route_result?: Record<string, unknown>;
  error?: string;
}

interface RecommendationRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  gap_type: string;
  title: string;
  rationale: string;
  route: "build" | "optimizer";
  target_slug: string | null;
  evidence: Record<string, unknown> | null;
}

/**
 * Enact an approved recommendation. route='build' → enqueue an agent_jobs build for the missing
 * component spec (mirrors the storefront-optimizer's missing-tool→build). route='optimizer' →
 * stand up a storefront_experiments DRAFT (control + a structural variant arm) the bandit can run.
 * Called by the approval route AFTER the owner approves — never autonomously.
 */
export async function enactRecommendationRoute(rec: RecommendationRow, userId: string | null): Promise<EnactResult> {
  const admin = createAdminClient();

  if (rec.route === "build") {
    const slug = rec.target_slug || `pdp-${rec.gap_type.replace(/_/g, "-")}`;
    const instructions = JSON.stringify({
      source: "landing-page-scout",
      gap_type: rec.gap_type,
      title: rec.title,
      rationale: rec.rationale,
      product_id: rec.product_id,
      recommendation_id: rec.id,
      note: "Author + build the missing PDP component this gap requires, then route it into the storefront-optimizer toolbox.",
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

  // route === 'optimizer' — needs a concrete product to scope the experiment.
  if (!rec.product_id) return { ok: false, error: "optimizer route needs a product_id on the recommendation" };
  const { data: exp, error: expErr } = await admin
    .from("storefront_experiments")
    .insert({
      workspace_id: rec.workspace_id,
      product_id: rec.product_id,
      lander_type: "pdp",
      audience: "all",
      lever: `lander-gap:${rec.gap_type}`,
      hypothesis: rec.title,
      status: "draft",
      holdout_pct: 0.1,
      created_by: userId,
      last_decision: {
        action: "authored",
        by: "landing-page-scout",
        gap_type: rec.gap_type,
        rationale: rec.rationale,
        recommendation_id: rec.id,
      },
    })
    .select("id")
    .single();
  if (expErr) return { ok: false, error: expErr.message };

  // Control + a structural variant arm (the patch is filled in when the optimizer designs the test).
  const { error: armErr } = await admin.from("storefront_experiment_variants").insert([
    { experiment_id: exp.id, workspace_id: rec.workspace_id, label: "control", is_control: true, patch: {} },
    {
      experiment_id: exp.id,
      workspace_id: rec.workspace_id,
      label: rec.gap_type,
      is_control: false,
      patch: { lander_gap: rec.gap_type, source: "landing-page-scout" },
    },
  ]);
  if (armErr) return { ok: false, error: armErr.message };

  return { ok: true, route_result: { experiment_id: exp.id } };
}
