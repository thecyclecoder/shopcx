/**
 * Box product-seed — DETERMINISTIC tools (box-product-seeding, corrected).
 *
 * 🚨 NO Anthropic API here. The box's LLM work runs on Max via a top-level
 * `claude -p` (the `seed-product` skill); these are the deterministic I/O
 * helpers that skill calls through `scripts/seed-product-tools.ts`:
 *   PDP fetch · DB reads/writes · Drive (service-account) packshot resolution ·
 *   the Gemini (Nano Banana Pro) image API · publish.
 *
 * All REASONING — ingredient extraction, web-search ingredient research,
 * review analysis, benefit triangulation, content authoring, hero vision-QA —
 * is done by the skill's own Claude on Max, NOT here. This file never imports
 * `engine.ts` (the Anthropic-API path) — that stays the SEPARATE Inngest/UI
 * engine. See docs/brain/specs/box-product-seeding.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import sharp from "sharp";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "@/lib/gemini";
import { DriveClient, resolveProductShots, resolveLifestyleShots, HERO_EXAMPLE_FOLDER_ID, type DriveFile } from "@/lib/google-drive";
import { publishProductContent } from "@/lib/product-intelligence/publish";

type Admin = ReturnType<typeof createAdminClient>;

export const PRODUCT_MEDIA_BUCKET = "product-media";

// Hero gallery dimensions — landscape 1800×1344 (the Amazing Coffee hero size).
// Square 1024×1024 heroes get cut off in the storefront gallery, so heroes are
// rendered at this aspect (Nano Banana Pro `4:3`) and padded to exact size on
// white. Ingredient thumbnails match Amazing Coffee at 400×400. See the
// "Image refinements (round 2)" section of box-product-seeding.md.
export const HERO_WIDTH = 1800;
export const HERO_HEIGHT = 1344;
export const HERO_ASPECT: NanoBananaAspect = "4:3"; // 1800/1344 ≈ 1.339, closest accepted ratio
export const INGREDIENT_SIZE = 400;

// Handles whose heroes are already perfect + locked — the box skips image gen
// entirely (box-product-seeding §6). Non-image intelligence may still be seeded.
export const LOCKED_HERO_HANDLES = new Set(["amazing-coffee", "amazing-coffee-pods", "amazing-creamer"]);

export type IntelligenceStatus =
  | "none" | "ingredients_added" | "researching" | "research_complete"
  | "analyzing_reviews" | "reviews_complete" | "benefits_selected"
  | "generating_content" | "content_generated" | "published";

function admin(): Admin {
  return createAdminClient();
}

// ── Product + status ─────────────────────────────────────────────────────────

export async function getProduct(workspace_id: string, product_id: string) {
  const a = admin();
  const { data: product } = await a
    .from("products")
    .select("id, title, handle, target_customer, certifications, description, intelligence_status")
    .eq("id", product_id)
    .eq("workspace_id", workspace_id)
    .single();
  if (!product) throw new Error("product_not_found");
  const { data: variants } = await a
    .from("product_variants")
    .select("title, option1, option2, available, position")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("position");
  return { product, variants: variants || [] };
}

export async function setStatus(workspace_id: string, product_id: string, status: IntelligenceStatus) {
  await admin().from("products").update({ intelligence_status: status }).eq("id", product_id).eq("workspace_id", workspace_id);
  return { ok: true, status };
}

/**
 * Normalize trust-pill input to ONE item per array element: split any
 * comma-joined string into separate pills, trim, drop empties, dedup
 * case-insensitively (first occurrence wins, order preserved). So
 * `["Non-GMO, 3rd Party Tested", "Made in USA"]` → 3 pills. The storefront
 * `TrustChipRow` renders one chip per element, so a comma-joined element shows
 * as a single run-on chip — this guarantees individual chips no matter how the
 * skill phrases the list.
 */
export function splitTrustPills(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.flatMap((x) => (typeof x === "string" ? x.split(",") : []))
    : typeof input === "string"
      ? input.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = r.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Persist the product's trust pills (`products.certifications` / `allergen_free`)
 * as individual items. Each field is normalized through `splitTrustPills`, so the
 * skill's content step always lands one pill per array element. Only the provided
 * fields are written. Returns the resulting arrays.
 */
export async function saveTrustPills(
  workspace_id: string,
  product_id: string,
  pills: { certifications?: unknown; allergen_free?: unknown },
): Promise<{ certifications: string[]; allergen_free: string[] }> {
  const a = admin();
  const update: Record<string, string[]> = {};
  if (pills.certifications !== undefined) update.certifications = splitTrustPills(pills.certifications);
  if (pills.allergen_free !== undefined) update.allergen_free = splitTrustPills(pills.allergen_free);
  if (Object.keys(update).length > 0) {
    const { error } = await a.from("products").update(update).eq("id", product_id).eq("workspace_id", workspace_id);
    if (error) throw new Error(`trust_pills_update: ${error.message}`);
  }
  const { data } = await a
    .from("products")
    .select("certifications, allergen_free")
    .eq("id", product_id)
    .eq("workspace_id", workspace_id)
    .single();
  return {
    certifications: (data?.certifications as string[]) || [],
    allergen_free: (data?.allergen_free as string[]) || [],
  };
}

// ── 1. PDP fetch + ingredients ───────────────────────────────────────────────

const STOREFRONT_BASE = process.env.SUPERFOODS_STOREFRONT_BASE || "https://superfoodscompany.com";

/** Fetch the live PDP and reduce it to readable text (scripts/styles/tags stripped). */
export async function fetchPdpText(handle: string): Promise<string | null> {
  const res = await fetch(`${STOREFRONT_BASE}/products/${handle}`, {
    headers: { "User-Agent": "ShopCX-box/1.0 (+product-seeding)" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60000);
}

export type ExtractedIngredient = { name: string; dosage_display?: string | null };

/**
 * Persist ingredients the skill extracted from the PDP. Idempotent: if the
 * product already has ingredients we keep them (manual entry / a prior run wins).
 */
export async function saveIngredients(
  workspace_id: string,
  product_id: string,
  ingredients: ExtractedIngredient[],
): Promise<{ added: number; existing: number }> {
  const a = admin();
  const { data: existing } = await a
    .from("product_ingredients")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id);
  const existingCount = existing?.length || 0;
  if (existingCount > 0) return { added: 0, existing: existingCount };

  const clean = (ingredients || []).filter((i) => i && typeof i.name === "string" && i.name.trim());
  if (clean.length === 0) return { added: 0, existing: 0 };
  const rows = clean.map((ing, i) => ({
    workspace_id,
    product_id,
    name: ing.name.trim(),
    dosage_display: ing.dosage_display?.trim() || null,
    display_order: i,
  }));
  const { error } = await a.from("product_ingredients").insert(rows);
  if (error) throw new Error(`ingredient_insert: ${error.message}`);
  return { added: rows.length, existing: 0 };
}

export async function getIngredients(workspace_id: string, product_id: string) {
  const { data } = await admin()
    .from("product_ingredients")
    .select("id, name, dosage_mg, dosage_display, display_order")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("display_order");
  return data || [];
}

// ── 2. Ingredient research (the skill researches by WEB SEARCH; we persist) ───

export type ResearchRow = {
  ingredient_id: string;
  benefit_headline: string;
  mechanism_explanation?: string;
  clinically_studied_benefits?: string[];
  dosage_comparison?: string | null;
  citations?: Array<{ title?: string; authors?: string; journal?: string; year?: number | string; doi?: string; url?: string }>;
  contraindications?: string | null;
  ai_confidence?: number;
};

/**
 * Persist web-search ingredient research. Replaces rows per ingredient so a
 * re-run cleanly supersedes. Validates ingredient_id against the product's
 * ingredients. Each row should carry REAL citations (the skill must include them).
 */
export async function saveResearch(
  workspace_id: string,
  product_id: string,
  rows: ResearchRow[],
): Promise<{ saved: number; ingredients: number }> {
  const a = admin();
  const ingredients = await getIngredients(workspace_id, product_id);
  const validIds = new Set(ingredients.map((i) => i.id as string));
  const valid = (rows || []).filter(
    (r) => r && validIds.has(r.ingredient_id) && typeof r.benefit_headline === "string" && r.benefit_headline.trim(),
  );

  // Clean-replace each touched ingredient's prior rows.
  const touched = [...new Set(valid.map((r) => r.ingredient_id))];
  for (const ingredient_id of touched) {
    await a.from("product_ingredient_research").delete().eq("workspace_id", workspace_id).eq("ingredient_id", ingredient_id);
  }

  const insertRows = valid.map((r) => ({
    workspace_id,
    product_id,
    ingredient_id: r.ingredient_id,
    benefit_headline: r.benefit_headline.trim(),
    mechanism_explanation: r.mechanism_explanation || "",
    clinically_studied_benefits: Array.isArray(r.clinically_studied_benefits) ? r.clinically_studied_benefits : [],
    dosage_comparison: r.dosage_comparison || null,
    citations: Array.isArray(r.citations) ? r.citations : [],
    contraindications: r.contraindications || null,
    ai_confidence: typeof r.ai_confidence === "number" ? Math.max(0, Math.min(1, r.ai_confidence)) : 0.5,
    researched_at: new Date().toISOString(),
  }));
  if (insertRows.length > 0) {
    const { error } = await a.from("product_ingredient_research").insert(insertRows);
    if (error) throw new Error(`research_insert: ${error.message}`);
  }
  return { saved: insertRows.length, ingredients: touched.length };
}

export async function getResearch(workspace_id: string, product_id: string) {
  const { data } = await admin()
    .from("product_ingredient_research")
    .select("id, ingredient_id, benefit_headline, mechanism_explanation, dosage_comparison, ai_confidence")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id);
  return data || [];
}

// ── 3. Reviews (workspace DB; 4–5★, featured-weighted) ────────────────────────

/**
 * A page of the best product-specific reviews (4★+, non-empty body,
 * featured-weighted) so the skill can read them in chunks and analyze them
 * itself. Returns `{ total, offset, reviews }`.
 *
 * Range-based pagination (NOT `.limit(2000)`): PostgREST caps any single
 * response at the server `max-rows` ceiling (1000), so the old `.limit(2000)`
 * silently truncated to 1000 — a product with 3,000+ 4★ reviews (Superfood
 * Tabs) had its review analysis built from a third of the corpus, which is why
 * benefit-pill category counts read 1–4 instead of hundreds. We now order in
 * the DB (featured → rating → recency, the weighting the skill wants) and page
 * with `.range(offset, offset+limit-1)`, so the skill can walk the FULL corpus
 * one page at a time. `total` is an exact count over the same filter.
 */
export async function getReviews(
  workspace_id: string,
  product_id: string,
  offset = 0,
  limit = 100,
) {
  const a = admin();

  const { count } = await a
    .from("product_reviews")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .in("status", ["published", "featured"])
    .gte("rating", 4)
    .not("body", "is", null);

  const { data } = await a
    .from("product_reviews")
    .select("id, reviewer_name, rating, title, body, status, featured")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .in("status", ["published", "featured"])
    .gte("rating", 4)
    .not("body", "is", null)
    // Featured first (weighting), then highest rating, then newest. This is the
    // canonical DB ordering — stable across pages so `.range()` walks the corpus
    // without gaps or repeats.
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const reviews = (data || []).filter((r) => (r.body || "").trim().length > 0);
  return { total: count || 0, offset, reviews };
}

export type ReviewAnalysis = {
  top_benefits?: unknown[];
  before_after_pain_points?: unknown[];
  skeptic_conversions?: unknown[];
  surprise_benefits?: unknown[];
  most_powerful_phrases?: unknown[];
};

export async function saveReviewAnalysis(
  workspace_id: string,
  product_id: string,
  analysis: ReviewAnalysis,
  reviewsAnalyzed: number,
): Promise<{ ok: true }> {
  await admin().from("product_review_analysis").upsert(
    {
      workspace_id,
      product_id,
      top_benefits: analysis.top_benefits || [],
      before_after_pain_points: analysis.before_after_pain_points || [],
      skeptic_conversions: analysis.skeptic_conversions || [],
      surprise_benefits: analysis.surprise_benefits || [],
      most_powerful_phrases: analysis.most_powerful_phrases || [],
      reviews_analyzed_count: reviewsAnalyzed,
      raw_ai_response: { source: "box-max-skill", reviews_analyzed: reviewsAnalyzed } as Record<string, unknown>,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,product_id" },
  );
  return { ok: true };
}

export async function getReviewAnalysis(workspace_id: string, product_id: string) {
  const { data } = await admin()
    .from("product_review_analysis")
    .select("top_benefits, before_after_pain_points, skeptic_conversions, surprise_benefits, most_powerful_phrases, reviews_analyzed_count")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .maybeSingle();
  return data || {};
}

// ── 4. Triangulated benefit selection (the skill triangulates; we persist) ────

export type BenefitTheme = {
  theme_name: string;
  role: "lead" | "supporting" | "skip";
  science_confirmed?: boolean;
  customer_confirmed?: boolean;
  max_confidence?: number | null;
  research_ids?: string[];
  customer_review_ids?: string[];
  ingredient_names?: string[];
  customer_benefit_names?: string[];
  customer_phrases?: string[];
  reason?: string;
};

/**
 * Persist the triangulated benefit selections. Validates research IDs (and, if
 * provided, review IDs) so every kept pick carries traceable evidence. Replaces
 * prior selections (idempotent re-run). Returns lead/supporting counts.
 */
export async function saveBenefits(
  workspace_id: string,
  product_id: string,
  themes: BenefitTheme[],
): Promise<{ lead: number; supporting: number; total: number }> {
  const a = admin();
  const research = await getResearch(workspace_id, product_id);
  const validResearchIds = new Set(research.map((r) => r.id as string));

  const list = (themes || []).filter((t) => t && typeof t.theme_name === "string" && t.theme_name.trim());
  const rows = list.map((t, i) => {
    const role = (["lead", "supporting", "skip"] as const).includes(t.role) ? t.role : "supporting";
    const researchIds = (t.research_ids || []).filter((id) => validResearchIds.has(id));
    const reviewIds = [...new Set((t.customer_review_ids || []).filter(Boolean))];
    return {
      workspace_id,
      product_id,
      benefit_name: t.theme_name.trim(),
      role,
      display_order: i,
      science_confirmed: !!t.science_confirmed,
      customer_confirmed: !!t.customer_confirmed,
      customer_phrases: Array.isArray(t.customer_phrases) ? t.customer_phrases : [],
      customer_review_ids: reviewIds,
      ingredient_research_ids: researchIds,
      ai_confidence: typeof t.max_confidence === "number" ? t.max_confidence : null,
      notes: `${(t.ingredient_names || []).length ? "Ingredients: " + t.ingredient_names!.join(", ") : ""}${(t.customer_benefit_names || []).length ? " | Customer: " + t.customer_benefit_names!.join(", ") : ""}${t.reason ? " | " + t.reason : ""}`.trim(),
    };
  });

  await a.from("product_benefit_selections").delete().eq("workspace_id", workspace_id).eq("product_id", product_id);
  if (rows.length > 0) {
    const { error } = await a.from("product_benefit_selections").insert(rows);
    if (error) throw new Error(`benefit_insert: ${error.message}`);
  }
  return {
    lead: rows.filter((r) => r.role === "lead").length,
    supporting: rows.filter((r) => r.role === "supporting").length,
    total: rows.filter((r) => r.role !== "skip").length,
  };
}

export async function getBenefits(workspace_id: string, product_id: string) {
  const { data } = await admin()
    .from("product_benefit_selections")
    .select("benefit_name, role, display_order, science_confirmed, customer_confirmed, customer_phrases, ai_confidence, notes, ingredient_research_ids, customer_review_ids")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("display_order");
  return data || [];
}

// ── 5. Page content (the skill authors it; we version + persist) ──────────────

export type GeneratedContent = {
  hero_headline?: string;
  hero_subheadline?: string;
  benefit_bar?: unknown[];
  mechanism_copy?: string;
  ingredient_cards?: unknown[];
  comparison_table_rows?: unknown[];
  // Round-3 lander refinements: the rival column label (null → "Regular Coffee"
  // default in the renderer) + whether the coffee-specific survey chapter renders.
  comparison_competitor_label?: string | null;
  show_survey?: boolean;
  faq_items?: unknown[];
  guarantee_copy?: string;
  knowledge_base_article?: string;
  kb_what_it_doesnt_do?: string;
  fda_disclaimer?: string;
  support_macros?: unknown[];
  endorsements?: unknown[];
  expectation_timeline?: unknown[];
  // Up to 2 before/after testimonials [{quote,name,variant}] — pairs with media
  // slots before_1/after_1, before_2/after_2 (harvested + re-hosted from the PDP).
  before_after_stories?: unknown[];
};

export async function saveContent(
  workspace_id: string,
  product_id: string,
  content: GeneratedContent,
): Promise<{ content_id: string; version: number }> {
  const a = admin();
  const { data: latest } = await a
    .from("product_page_content")
    .select("version")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (latest?.version || 0) + 1;

  const { data: inserted, error } = await a
    .from("product_page_content")
    .insert({
      workspace_id,
      product_id,
      version: nextVersion,
      hero_headline: content.hero_headline || null,
      hero_subheadline: content.hero_subheadline || null,
      benefit_bar: Array.isArray(content.benefit_bar) ? content.benefit_bar : [],
      mechanism_copy: content.mechanism_copy || null,
      ingredient_cards: Array.isArray(content.ingredient_cards) ? content.ingredient_cards : [],
      comparison_table_rows: Array.isArray(content.comparison_table_rows) ? content.comparison_table_rows : [],
      comparison_competitor_label: content.comparison_competitor_label || null,
      show_survey: content.show_survey === true,
      faq_items: Array.isArray(content.faq_items) ? content.faq_items : [],
      guarantee_copy: content.guarantee_copy || null,
      knowledge_base_article: content.knowledge_base_article || null,
      kb_what_it_doesnt_do: content.kb_what_it_doesnt_do || null,
      fda_disclaimer: content.fda_disclaimer || null,
      support_macros: Array.isArray(content.support_macros) ? content.support_macros : [],
      endorsements: Array.isArray(content.endorsements) ? content.endorsements : [],
      expectation_timeline: Array.isArray(content.expectation_timeline) ? content.expectation_timeline : [],
      before_after_stories: Array.isArray(content.before_after_stories) ? content.before_after_stories : [],
      raw_ai_response: { source: "box-max-skill" } as Record<string, unknown>,
      status: "draft",
      generated_at: new Date().toISOString(),
    })
    .select("id, version")
    .single();
  if (error || !inserted) throw new Error(`content_insert: ${error?.message || "no row"}`);
  return { content_id: inserted.id as string, version: inserted.version as number };
}

export async function getContent(workspace_id: string, product_id: string) {
  const { data } = await admin()
    .from("product_page_content")
    .select("id, version, status, hero_headline, fda_disclaimer, kb_what_it_doesnt_do, benefit_bar, mechanism_copy")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// ── 6. Hero / supporting imagery (Drive packshot + Nano Banana Pro) ───────────

export async function heroStatus(
  workspace_id: string,
  product_id: string,
  handle: string | null,
): Promise<{ locked: boolean; exists: boolean }> {
  const locked = !!handle && LOCKED_HERO_HANDLES.has(handle);
  const { data } = await admin()
    .from("product_media")
    .select("url")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .eq("slot", "hero")
    .not("url", "is", null)
    .maybeSingle();
  return { locked, exists: !!data?.url };
}

function publicUrl(a: Admin, path: string): string {
  return a.storage.from(PRODUCT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function uploadImage(a: Admin, path: string, buffer: Buffer, contentType: string): Promise<string> {
  const { error } = await a.storage.from(PRODUCT_MEDIA_BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`product_media_upload: ${error.message}`);
  return publicUrl(a, path);
}

/**
 * Resize an image to EXACTLY width×height, centered on a white background
 * (`fit: contain` → letterbox/pad, no crop). Used to force heroes to the exact
 * 1800×1344 gallery size even when Nano Banana Pro returns a near-aspect, and to
 * normalize PDP ingredient images to 400×400. Returns the encoded bytes + mime.
 */
async function fitOnWhite(
  buffer: Buffer,
  width: number,
  height: number,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const isJpeg = /jpe?g/i.test(mimeType);
  let pipe = sharp(buffer)
    .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } });
  pipe = isJpeg ? pipe.jpeg({ quality: 90 }) : pipe.png();
  return { buffer: await pipe.toBuffer(), mimeType: isJpeg ? "image/jpeg" : "image/png" };
}

/**
 * Crop-to-fill an image to EXACTLY width×height (`fit: cover` → fills the frame,
 * cropping overflow, no letterbox). Used for full-bleed lifestyle / scene shots
 * that should fill the locked 1800×1344 gallery frame, where `fitOnWhite`'s
 * letterboxing would look wrong. Returns the encoded bytes + mime.
 */
async function coverCrop(
  buffer: Buffer,
  width: number,
  height: number,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const isJpeg = /jpe?g/i.test(mimeType);
  let pipe = sharp(buffer).resize(width, height, { fit: "cover", position: "centre" });
  pipe = isJpeg ? pipe.jpeg({ quality: 90 }) : pipe.png();
  return { buffer: await pipe.toBuffer(), mimeType: isJpeg ? "image/jpeg" : "image/png" };
}

/** Escape text for safe embedding in an SVG `<text>` node. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy word-wrap to ~maxChars per line (approximate — SVG has no auto-wrap). */
function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Composite winning-static-ad caption overlays onto an image. The FIRST caption
 * is the top hook, the SECOND (optional) the bottom payoff — bold white text
 * with a dark stroke + a translucent gradient band behind each block for
 * legibility, the look of a high-performing paid-social static. Captions are
 * word-wrapped and rendered via an SVG composited over the (already exact-size)
 * image. No-op (returns the input) when there are no captions.
 */
async function overlayCaptions(
  buffer: Buffer,
  captions: string[],
  width: number,
  height: number,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const clean = (captions || []).map((c) => (c || "").trim()).filter(Boolean).slice(0, 2);
  if (clean.length === 0) return { buffer, mimeType };

  const fontSize = Math.round(width * 0.052);
  const lineHeight = Math.round(fontSize * 1.18);
  const pad = Math.round(width * 0.04);
  const maxChars = Math.max(12, Math.floor(width / (fontSize * 0.56)));

  const renderBlock = (text: string, anchor: "top" | "bottom"): string => {
    const lines = wrapLines(text, maxChars);
    const blockH = lines.length * lineHeight;
    const bandH = blockH + pad * 1.5;
    const bandY = anchor === "top" ? 0 : height - bandH;
    const firstBaseline =
      anchor === "top" ? pad + fontSize : height - bandH + pad * 0.75 + fontSize;
    const gradId = `band_${anchor}`;
    const stops =
      anchor === "top"
        ? `<stop offset="0%" stop-color="black" stop-opacity="0.6"/><stop offset="100%" stop-color="black" stop-opacity="0"/>`
        : `<stop offset="0%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="0.6"/>`;
    const tspans = lines
      .map((ln, i) => `<tspan x="${width / 2}" y="${Math.round(firstBaseline + i * lineHeight)}">${escapeXml(ln)}</tspan>`)
      .join("");
    return `
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>
      <rect x="0" y="${Math.round(bandY)}" width="${width}" height="${Math.round(bandH)}" fill="url(#${gradId})"/>
      <text text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}" fill="white" stroke="black" stroke-width="${Math.max(2, Math.round(fontSize * 0.06))}" paint-order="stroke" letter-spacing="-0.5">${tspans}</text>`;
  };

  const blocks: string[] = [];
  blocks.push(renderBlock(clean[0], "top"));
  if (clean[1]) blocks.push(renderBlock(clean[1], "bottom"));

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs></defs>${blocks.join("")}</svg>`;
  const isJpeg = /jpe?g/i.test(mimeType);
  let pipe = sharp(buffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  pipe = isJpeg ? pipe.jpeg({ quality: 90 }) : pipe.png();
  return { buffer: await pipe.toBuffer(), mimeType: isJpeg ? "image/jpeg" : "image/png" };
}

/**
 * Resolve the isolated front-facing packshot from the workspace Drive (SA key)
 * plus the `Hero Example` reference set, upload them to storage, and return the
 * URLs to feed Nano Banana Pro. The skill chose `variantKeywords` (one variant).
 */
export async function resolvePackshot(
  workspace_id: string,
  product_id: string,
  productName: string,
  variantKeywords: string[],
): Promise<{ packUrl: string; refUrls: string[]; candidate: string; candidates: string[] }> {
  const a = admin();
  const drive = await DriveClient.forWorkspace(workspace_id);
  if (!drive) throw new Error("google_drive_not_connected (workspace SA key missing)");

  const candidates = await resolveProductShots(drive, { productName, variantKeywords, preferBag: true });
  if (candidates.length === 0) throw new Error(`no isolated packshot found in Drive for "${productName}"`);
  const top = candidates[0];
  const packDl = await drive.download(top.id);
  if (!packDl) throw new Error("packshot download failed");
  const packUrl = await uploadImage(a, `_seed/${product_id}/packshot-${top.id}.png`, packDl.buffer, packDl.mimeType);

  const refUrls: string[] = [];
  const refs: DriveFile[] = (await drive.listImagesInFolder(HERO_EXAMPLE_FOLDER_ID)).slice(0, 2);
  for (const ref of refs) {
    const dl = await drive.download(ref.id);
    if (dl) refUrls.push(await uploadImage(a, `_seed/${product_id}/ref-${ref.id}.png`, dl.buffer, dl.mimeType));
  }
  return { packUrl, refUrls, candidate: top.name, candidates: candidates.slice(0, 8).map((c) => c.name) };
}

/**
 * Generate one image via Nano Banana Pro and write it to a LOCAL temp file so
 * the skill can Read it (vision-confirm the locked composition) before saving.
 * Returns the local path + mime type. Does NOT persist a product_media row.
 */
export async function generateImage(
  workspace_id: string,
  product_id: string,
  prompt: string,
  imageUrls: string[],
  slot: string,
  aspectRatio: NanoBananaAspect = "1:1",
  width?: number,
  height?: number,
): Promise<{ localPath: string; mimeType: string }> {
  const gen = await generateNanoBananaProCombine({ workspaceId: workspace_id, prompt, imageUrls, aspectRatio });
  let buffer = gen.buffer;
  let mimeType = gen.mimeType;
  // Force the exact gallery size on white when the caller asks (heroes →
  // 1800×1344). Pads a near-aspect render rather than letting the storefront
  // gallery crop a square.
  if (width && height) {
    const fitted = await fitOnWhite(buffer, width, height, mimeType);
    buffer = fitted.buffer;
    mimeType = fitted.mimeType;
  }
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  const localPath = join(tmpdir(), `seed-${product_id}-${slot}-${Date.now()}.${ext}`);
  writeFileSync(localPath, buffer);
  return { localPath, mimeType };
}

/**
 * Persist a vision-approved image to storage + product_media. The skill calls
 * this only AFTER it has Read the local file and confirmed it matches the
 * locked composition.
 */
export async function saveMedia(
  workspace_id: string,
  product_id: string,
  slot: string,
  localPath: string,
  mimeType: string,
  altText: string,
  displayOrder = 0,
): Promise<{ url: string }> {
  const a = admin();
  const { readFileSync } = await import("fs");
  const buffer = readFileSync(localPath);
  const ext = mimeType.includes("jpeg") ? "jpg" : "png";
  // Gallery rows (display_order > 0) get a distinct storage path so multiple
  // images can share one slot (e.g. the hero gallery: hero, hero_1, hero_2…).
  const storagePath = `${product_id}/${slot}${displayOrder ? `_${displayOrder}` : ""}.${ext}`;
  const url = await uploadImage(a, storagePath, buffer, mimeType);
  const meta = await sharp(buffer).metadata().catch(() => null);
  await a.from("product_media").upsert(
    {
      workspace_id,
      product_id,
      slot,
      display_order: displayOrder,
      url,
      storage_path: storagePath,
      alt_text: altText,
      mime_type: mimeType,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      file_size: buffer.length,
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,product_id,slot,display_order" },
  );
  return { url };
}

/**
 * List the product's existing `product_media` slots (with urls). The skill uses
 * this to decide which chapter images are still MISSING — so the round-3
 * chapter-image pass (lifestyle_1 / timeline_N) is idempotent and only fills
 * blanks. Returns `{ slots, bySlot }` where `slots` is the present-with-url set.
 */
export async function getMedia(
  workspace_id: string,
  product_id: string,
): Promise<{ slots: string[]; bySlot: Record<string, string> }> {
  const { data } = await admin()
    .from("product_media")
    .select("slot, url")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .not("url", "is", null);
  const bySlot: Record<string, string> = {};
  for (const r of data || []) bySlot[r.slot as string] = r.url as string;
  return { slots: Object.keys(bySlot), bySlot };
}

// ── 6b. Per-ingredient images FROM the Shopify PDP CDN (round 2) ──────────────
//
// The PDP's ingredient section serves CDN images named by ingredient
// (Ashwagandha_1.jpg, Beet_Root.jpg, Chlorella.jpg, Grape_Seed_Extract.jpg,
// D3_1.jpg). We pull the REAL images (NOT Gemini), match each to a
// product_ingredient by name, normalize to 400×400, and write product_media
// slot=ingredient_{snake_name}. Round 1 left these blank → empty ingredient cards.

/** Ingredient → `ingredient_{snake_name}` storage slot. */
export function ingredientSlot(name: string): string {
  return `ingredient_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

// Generic supplement descriptors + PDP filename prefixes that vary between PDPs
// and should NOT drive ingredient matching — the DISTINCTIVE token does
// ("Vitamin D3" → d3, "MCT Oil" → mct, "Beet Root" → beet, "Hyaluronic Acid" →
// hyaluronic, "creamer-ingredient-collagen" → collagen). Stripping these makes
// the match robust across naming conventions (TitleCase_underscore like
// `Ashwagandha_1.jpg` vs lowercase-dashed-prefixed like
// `creamer-ingredient-collagen.jpg`). See box-product-seeding.md (round-2 fix).
const GENERIC_INGREDIENT_TOKENS = new Set([
  "vitamin", "vit", "organic", "extract", "powder", "root", "complex", "blend",
  "fruit", "leaf", "bark", "seed", "oil", "acid", "standardized", "concentrate",
  "isolate", "whole", "raw", "pure", "ingredient", "ingredients",
]);

/** Lowercase alphanumeric tokens (split on any non-alphanumeric run). */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The DISTINCTIVE tokens of an ingredient name: generics + pure-index numbers +
 * lone non-numeric single chars dropped (so "L-Theanine" → theanine, "D3" → d3).
 * Falls back to all ≥2-char/alphanumeric tokens if stripping generics empties it.
 */
function significantTokens(s: string): string[] {
  const toks = tokenize(s).filter((t) => !/^\d+$/.test(t)); // drop "_1" index numbers
  const keep = (t: string) => t.length >= 2 || /\d/.test(t);
  const sig = toks.filter((t) => keep(t) && !GENERIC_INGREDIENT_TOKENS.has(t));
  return [...new Set(sig.length ? sig : toks.filter(keep))];
}

/** Raw PDP HTML (NOT tag-stripped) so we can pull CDN image URLs from img/srcset. */
async function fetchPdpHtml(handle: string): Promise<string | null> {
  const res = await fetch(`${STOREFRONT_BASE}/products/${handle}`, {
    headers: { "User-Agent": "ShopCX-box/1.0 (+product-seeding)" },
  });
  if (!res.ok) return null;
  return res.text();
}

/** Strip the Shopify size transform (`_400x400`, `_600x`, `@2x`) + query → master file. */
function cleanShopifyUrl(raw: string): string {
  let u = raw.startsWith("//") ? `https:${raw}` : raw;
  u = u.split("?")[0];
  u = u.replace(/_\d+x\d*(@\dx)?(\.(?:jpe?g|png|webp))$/i, "$2");
  return u;
}

export type PdpImage = { cleanUrl: string; filename: string; tokens: string[] };

/**
 * Every distinct Shopify-CDN image on the PDP. Matches both the storefront CDN
 * path (`superfoodscompany.com/cdn/shop/files/…`, what the live PDP actually
 * serves) and the legacy `cdn.shopify.com/…` host — the prior regex only matched
 * the latter, so these PDPs returned 0 images. Each image carries its filename
 * tokens for ingredient matching.
 */
export function extractPdpImages(html: string): PdpImage[] {
  const re =
    /(?:https?:)?\/\/(?:cdn\.shopify\.com|[a-z0-9.-]+\/cdn\/shop)\/[^\s"'\\)]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'\\)]*)?/gi;
  const seen = new Set<string>();
  const out: PdpImage[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cleanUrl = cleanShopifyUrl(m[0]);
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);
    const filename = decodeURIComponent(cleanUrl.split("/").pop() || "");
    const tokens = tokenize(filename.replace(/\.(?:jpe?g|png|webp)$/i, "")).filter((t) => !/^\d+$/.test(t));
    out.push({ cleanUrl, filename, tokens });
  }
  return out;
}

/**
 * A PDP image whose filename contains the ingredient's significant token(s).
 * Both sides are normalized to lowercase alphanumeric tokens; an image matches
 * when EVERY distinctive ingredient token appears in (or as) a filename token —
 * so `collagen`/`mct`/`hyaluronic`/`d3` match `creamer-ingredient-collagen.jpg`,
 * `…-mct-oil.jpg`, `…-hyaluronic-acid.jpg`, and `D3_1.jpg` alike. Filename prefix
 * noise (`creamer`, `ingredient`) is harmless — it's never required.
 */
function matchIngredientImage(ingredientName: string, images: PdpImage[]): PdpImage | null {
  const sig = significantTokens(ingredientName);
  if (sig.length === 0) return null;
  // A token matches a filename token by equality, or by containment in EITHER
  // direction — but only when the contained side is ≥3 chars, so a stray 1–2-char
  // filename token (e.g. the `C` in `SHOP-COFFEE-I-C`) can't spuriously satisfy a
  // short ingredient token like `mct`.
  const inFile = (t: string, im: PdpImage) =>
    im.tokens.some(
      (ft) => ft === t || (ft.includes(t) && t.length >= 3) || (t.includes(ft) && ft.length >= 3),
    );
  const cands = images.filter((im) => im.tokens.length > 0 && sig.every((t) => inFile(t, im)));
  if (cands.length === 0) return null;
  // Prefer the most specific filename: an exact distinctive-token-set match
  // first, then the fewest tokens (least prefix noise), then the shortest name.
  const sigKey = [...sig].sort().join(",");
  const fileKey = (im: PdpImage) =>
    [...new Set(im.tokens.filter((t) => !GENERIC_INGREDIENT_TOKENS.has(t) && (t.length >= 2 || /\d/.test(t))))]
      .sort()
      .join(",");
  cands.sort((a, b) => {
    const ax = fileKey(a) === sigKey ? 1 : 0;
    const bx = fileKey(b) === sigKey ? 1 : 0;
    if (ax !== bx) return bx - ax;
    if (a.tokens.length !== b.tokens.length) return a.tokens.length - b.tokens.length;
    return a.filename.length - b.filename.length;
  });
  return cands[0];
}

/**
 * Pull per-ingredient images from the live PDP CDN, match by name, and write
 * `product_media` slot=`ingredient_{snake_name}` at 400×400. Deterministic — NO
 * Gemini. Idempotent (upserts the slot). Returns matched/unmatched per ingredient.
 */
export async function pullIngredientImages(
  workspace_id: string,
  product_id: string,
  handle: string,
): Promise<{
  matched: Array<{ ingredient: string; slot: string; url: string; source: string }>;
  unmatched: string[];
  pdp_images: number;
}> {
  const a = admin();
  const ingredients = await getIngredients(workspace_id, product_id);
  if (ingredients.length === 0) return { matched: [], unmatched: [], pdp_images: 0 };

  const html = await fetchPdpHtml(handle);
  if (!html) throw new Error("pdp_fetch_failed");
  const images = extractPdpImages(html);

  const matched: Array<{ ingredient: string; slot: string; url: string; source: string }> = [];
  const unmatched: string[] = [];

  for (const ing of ingredients) {
    const name = (ing.name as string) || "";
    const pick = matchIngredientImage(name, images);
    if (!pick) {
      unmatched.push(name);
      continue;
    }
    try {
      const dl = await fetch(pick.cleanUrl, { headers: { "User-Agent": "ShopCX-box/1.0 (+product-seeding)" } });
      if (!dl.ok) {
        unmatched.push(name);
        continue;
      }
      const raw = Buffer.from(await dl.arrayBuffer());
      const fitted = await fitOnWhite(raw, INGREDIENT_SIZE, INGREDIENT_SIZE, dl.headers.get("content-type") || "image/jpeg");
      const slot = ingredientSlot(name);
      const ext = fitted.mimeType.includes("jpeg") ? "jpg" : "png";
      const storagePath = `${product_id}/${slot}.${ext}`;
      const url = await uploadImage(a, storagePath, fitted.buffer, fitted.mimeType);
      await a.from("product_media").upsert(
        {
          workspace_id,
          product_id,
          slot,
          display_order: 0,
          url,
          storage_path: storagePath,
          alt_text: name,
          mime_type: fitted.mimeType,
          width: INGREDIENT_SIZE,
          height: INGREDIENT_SIZE,
          file_size: fitted.buffer.length,
          uploaded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,product_id,slot,display_order" },
      );
      matched.push({ ingredient: name, slot, url, source: pick.filename });
    } catch {
      unmatched.push(name);
    }
  }
  return { matched, unmatched, pdp_images: images.length };
}

// ── 6c. Nano Banana Pro FALLBACK for ingredients with NO PDP image ────────────
//
// The PDP pull (6b) is the PREFERRED source and stays the default. But some
// ingredients have no per-ingredient photo on the PDP (e.g. Creatine Prime's
// Creatine Monohydrate + Rhodiola; a few on other products) → blank ingredient
// cards. For ANY product_ingredient still missing its `ingredient_{snake}` media
// row AFTER the pull, generate a clean studio photo of the ingredient in its
// natural/raw recognizable form via Nano Banana Pro (text-to-image — no input
// packshot), normalize to 400×400 on white to match the pulled PDP thumbnails,
// and write product_media. ONLY generates when there is NO pulled image for that
// ingredient — never overwrites a PDP-sourced (or prior-run) image. The skill
// (which researched each ingredient) supplies the raw-form visual description; we
// fall back to a name-only prompt when none is given.

export type IngredientFallbackInput = { name: string; visual_description?: string };

/** The set of `ingredient_{snake}` slots already present (with a URL) in product_media. */
async function existingIngredientSlots(
  a: Admin,
  workspace_id: string,
  product_id: string,
): Promise<Set<string>> {
  const { data } = await a
    .from("product_media")
    .select("slot")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .like("slot", "ingredient\\_%")
    .not("url", "is", null);
  return new Set((data || []).map((r) => r.slot as string));
}

/** Studio ingredient-photo prompt matching the look of the pulled PDP thumbnails. */
function ingredientFallbackPrompt(name: string, visualDescription?: string): string {
  const form = visualDescription?.trim()
    ? `, shown in its natural raw recognizable form: ${visualDescription.trim()}`
    : ` in its natural, raw, recognizable form`;
  return [
    `A clean professional studio product photograph of the dietary supplement ingredient "${name}"${form}.`,
    `Pure seamless white background, soft even diffused lighting, sharp focus, centered composition, photorealistic, square framing.`,
    `No text, no labels, no packaging, no logos, no hands, no people — just the ingredient itself, like a clean ingredient catalog thumbnail.`,
  ].join(" ");
}

/**
 * Generate Nano Banana Pro studio photos for ingredients still missing a pulled
 * PDP image (the FALLBACK after `pullIngredientImages`). Idempotent: skips any
 * ingredient that already has an `ingredient_{snake}` media row, so the PDP pull
 * always wins. Best-effort per ingredient (a failure never blocks the rest /
 * publish). Returns generated / skipped (already had an image) / failed.
 */
export async function generateIngredientImagesFallback(
  workspace_id: string,
  product_id: string,
  descriptions: IngredientFallbackInput[] = [],
): Promise<{
  generated: Array<{ ingredient: string; slot: string; url: string }>;
  skipped: string[];
  failed: string[];
}> {
  const a = admin();
  const ingredients = await getIngredients(workspace_id, product_id);
  if (ingredients.length === 0) return { generated: [], skipped: [], failed: [] };

  const have = await existingIngredientSlots(a, workspace_id, product_id);
  const descByName = new Map(
    (descriptions || [])
      .filter((d) => d && typeof d.name === "string" && d.name.trim())
      .map((d) => [d.name.trim().toLowerCase(), d.visual_description] as const),
  );

  const generated: Array<{ ingredient: string; slot: string; url: string }> = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const ing of ingredients) {
    const name = (ing.name as string) || "";
    const slot = ingredientSlot(name);
    if (have.has(slot)) {
      // A PDP-pulled (or prior-run) image exists — PDP stays the preferred source.
      skipped.push(name);
      continue;
    }
    try {
      const prompt = ingredientFallbackPrompt(name, descByName.get(name.trim().toLowerCase()) || undefined);
      const gen = await generateNanoBananaProCombine({
        workspaceId: workspace_id,
        prompt,
        imageUrls: [], // text-to-image — no input packshot
        aspectRatio: "1:1",
      });
      const fitted = await fitOnWhite(gen.buffer, INGREDIENT_SIZE, INGREDIENT_SIZE, gen.mimeType);
      const ext = fitted.mimeType.includes("jpeg") ? "jpg" : "png";
      const storagePath = `${product_id}/${slot}.${ext}`;
      const url = await uploadImage(a, storagePath, fitted.buffer, fitted.mimeType);
      await a.from("product_media").upsert(
        {
          workspace_id,
          product_id,
          slot,
          display_order: 0,
          url,
          storage_path: storagePath,
          alt_text: name,
          mime_type: fitted.mimeType,
          width: INGREDIENT_SIZE,
          height: INGREDIENT_SIZE,
          file_size: fitted.buffer.length,
          uploaded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,product_id,slot,display_order" },
      );
      generated.push({ ingredient: name, slot, url });
    } catch {
      failed.push(name);
    }
  }
  return { generated, skipped, failed };
}

// ── 7. Harvest from the live Shopify PDP (endorsements + before/after) ────────
//
// The product's live superfoodscompany.com PDP already carries the REAL assets
// this refinement pass wants: nutritionist endorsements (name/credentials/quote
// + headshot) and customer before/after transformation stories (paired photos +
// testimonial). The skill reads the PDP text (`fetch-pdp`) + the image URL list
// (`pdp-images`) to identify them, then re-hosts each image through `rehostImage`
// and saves the text via `save-content` (endorsements / before_after_stories).
//
// 🚫 NEVER hotlink the Shopify CDN — `rehostImage` DOWNLOADS the source bytes and
// re-uploads them to our `product-media` bucket, so `product_media.url` is always
// a Supabase URL. (Hotlinking the Shopify CDN would break the moment Shopify is
// sunset and leak our re-platforming.) Replaces any fabricated AI endorsements.

/** The raw Shopify-CDN image list on the PDP (URL + filename tokens) for the
 *  skill to pick endorsement avatars / before-after photos from. */
export async function getPdpImages(handle: string): Promise<{ images: PdpImage[] }> {
  const html = await fetchPdpHtml(handle);
  if (!html) throw new Error("pdp_fetch_failed");
  return { images: extractPdpImages(html) };
}

export type RehostFit = "contain" | "cover" | "none";

/**
 * Download an image from its (Shopify CDN) source URL and re-host it to our
 * `product-media` bucket at `slot`/`displayOrder`, upserting the product_media
 * row. Returns OUR Supabase URL — the Shopify URL is never persisted. `fit`
 * `cover`/`contain` (with width+height) normalizes the asset (e.g. avatars →
 * 400×400 cover); `none` keeps native bytes/proportions (before/after photos).
 */
export async function rehostImage(
  workspace_id: string,
  product_id: string,
  sourceUrl: string,
  slot: string,
  opts: { displayOrder?: number; altText?: string; fit?: RehostFit; width?: number; height?: number } = {},
): Promise<{ url: string; slot: string; storage_path: string }> {
  const a = admin();
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) throw new Error("rehost: bad source url");
  const dl = await fetch(sourceUrl, { headers: { "User-Agent": "ShopCX-box/1.0 (+product-seeding)" } });
  if (!dl.ok) throw new Error(`rehost: source fetch ${dl.status}`);
  const ct = dl.headers.get("content-type") || "image/jpeg";
  if (!/image\//.test(ct)) throw new Error(`rehost: not an image (${ct})`);

  let buffer: Buffer = Buffer.from(await dl.arrayBuffer());
  let mimeType = ct;
  const fit = opts.fit || "none";
  if (fit !== "none" && opts.width && opts.height) {
    const norm = fit === "cover"
      ? await coverCrop(buffer, opts.width, opts.height, mimeType)
      : await fitOnWhite(buffer, opts.width, opts.height, mimeType);
    buffer = norm.buffer;
    mimeType = norm.mimeType;
  }

  const displayOrder = opts.displayOrder || 0;
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const storagePath = `${product_id}/${slot}${displayOrder ? `_${displayOrder}` : ""}.${ext}`;
  const url = await uploadImage(a, storagePath, buffer, mimeType);
  const meta = await sharp(buffer).metadata().catch(() => null);
  await a.from("product_media").upsert(
    {
      workspace_id,
      product_id,
      slot,
      display_order: displayOrder,
      url,
      storage_path: storagePath,
      alt_text: opts.altText || "",
      mime_type: mimeType,
      width: meta?.width ?? opts.width ?? null,
      height: meta?.height ?? opts.height ?? null,
      file_size: buffer.length,
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,product_id,slot,display_order" },
  );
  return { url, slot, storage_path: storagePath };
}

// ── 8 (was 6). Hero gallery slides — Drive lifestyle + Nano-Banana static ad ──
//
// Beyond the bag hero, the gallery gets two more `slot="hero"` rows (saved at
// display_order > 0 via save-media): a real lifestyle photo from Drive, and a
// Nano-Banana Pro static-ad scene with caption overlays. Both return a LOCAL
// temp file so the skill can vision-confirm before save-media (same flow as the
// hero). Recommended display_order: bag hero = 0, facts slide handled by the
// renderer, lifestyle = 2, static ad = 3 (skill picks; just keep them distinct).

/**
 * Resolve a real lifestyle photo from the product's Drive `UGC/Photos`, crop it
 * to the locked 1800×1344, and write it to a LOCAL temp file (no product_media
 * row yet). Returns the candidate name + the full candidate list so the skill
 * can re-call with a different `pickIndex` if the top shot isn't real-customer /
 * target-demo. Save with `save-media` (slot `hero`, a distinct displayOrder).
 */
export async function resolveLifestyleSlide(
  workspace_id: string,
  product_id: string,
  productName: string,
  variantKeywords: string[],
  pickIndex = 0,
): Promise<{ localPath: string; mimeType: string; candidate: string; candidates: string[] }> {
  const drive = await DriveClient.forWorkspace(workspace_id);
  if (!drive) throw new Error("google_drive_not_connected (workspace SA key missing)");
  const candidates = await resolveLifestyleShots(drive, { productName, variantKeywords });
  if (candidates.length === 0) throw new Error(`no lifestyle/UGC photos found in Drive for "${productName}"`);
  const idx = Math.min(Math.max(0, pickIndex), candidates.length - 1);
  const pick = candidates[idx];
  const dl = await drive.download(pick.id);
  if (!dl) throw new Error("lifestyle download failed");
  const fitted = await coverCrop(dl.buffer, HERO_WIDTH, HERO_HEIGHT, dl.mimeType);
  const ext = fitted.mimeType.includes("jpeg") ? "jpg" : "png";
  const localPath = join(tmpdir(), `seed-${product_id}-lifestyle-${idx}-${Date.now()}.${ext}`);
  writeFileSync(localPath, fitted.buffer);
  return { localPath, mimeType: fitted.mimeType, candidate: pick.name, candidates: candidates.slice(0, 8).map((c) => c.name) };
}

/**
 * Generate the Nano-Banana Pro static-ad gallery slide: a top-down kitchen-
 * counter scene (a hand holding the prioritized-variant pack + a made drink),
 * in the style of a winning paid-social static, then composite the caption
 * overlays (`captions[0]` = top hook, `captions[1]` = bottom payoff — copy the
 * skill pulled from the review corpus). Crops to the locked 1800×1344 and writes
 * a LOCAL temp file for vision-confirm. Save with `save-media` (slot `hero`,
 * distinct displayOrder). `imageUrls` = [prioritized-variant packUrl, …refs].
 */
export async function generateStaticAdSlide(
  workspace_id: string,
  product_id: string,
  imageUrls: string[],
  prompt: string,
  captions: string[] = [],
): Promise<{ localPath: string; mimeType: string }> {
  const gen = await generateNanoBananaProCombine({
    workspaceId: workspace_id,
    prompt,
    imageUrls: (imageUrls || []).filter(Boolean),
    aspectRatio: HERO_ASPECT,
  });
  const cropped = await coverCrop(gen.buffer, HERO_WIDTH, HERO_HEIGHT, gen.mimeType);
  const capped = await overlayCaptions(cropped.buffer, captions, HERO_WIDTH, HERO_HEIGHT, cropped.mimeType);
  const ext = capped.mimeType.includes("jpeg") ? "jpg" : "png";
  const localPath = join(tmpdir(), `seed-${product_id}-staticad-${Date.now()}.${ext}`);
  writeFileSync(localPath, capped.buffer);
  return { localPath, mimeType: capped.mimeType };
}

// ── 9. Publish ────────────────────────────────────────────────────────────────

export async function publish(workspace_id: string, product_id: string): Promise<{ ok: boolean; error?: string }> {
  const content = await getContent(workspace_id, product_id);
  if (!content?.id) return { ok: false, error: "no content version to publish" };
  const r = await publishProductContent(admin(), { workspace_id, product_id, contentId: content.id as string });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
