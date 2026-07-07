/**
 * Auto-generated ad-matched landers (advertorial + before/after).
 *
 * A lander is a LAYOUT MODE of the storefront PDP, reached via
 * `?variant=advertorial|beforeafter&angle={slug}`. It continues the scent of an
 * advertorial / before-after ad (editorial serif, real-person/ingredient hero,
 * "looks like an article, not an ad") so the cold-50+ click doesn't bounce on the
 * standard branded PDP. Only the custom top (hero + chapter 1) is generated; every
 * section below it (ingredients, pricing, reviews, checkout) is the existing PDP,
 * reused unchanged.
 *
 * This file is BOTH the reader the render path uses (`loadAdvertorialContent`) and
 * the generator the Inngest auto-trigger calls (`generateAdvertorialPage`). The
 * reader degrades gracefully: if no generated row exists (or the table isn't there
 * yet), it derives a sensible editorial top from the already-loaded PageData + PI
 * so the layout always renders. See docs/brain/specs/advertorial-landers.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { loadAngleInputs } from "@/lib/ad-angles";
import { validateAdScript } from "@/lib/ad-validator";
import { resolveAdToolSettings, DEFAULT_BANNED_WORDS } from "@/lib/ad-tool-config";
import { generateNanoBananaProCombine } from "@/lib/gemini";
import { compressToWebp } from "@/lib/blog/generate-images";
import type { AngleGeneratorInput } from "@/lib/ad-types";
import type { PageData, Review } from "@/app/(storefront)/_lib/page-data";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export type AdvertorialVariant = "advertorial" | "beforeafter" | "reasons";
export type AdvertorialHeroKind = "avatar" | "ingredient" | "beforeafter";

/** One item in a "N reasons why" listicle lander. */
export interface ReasonItem { heading: string; body: string }

/** Everything the advertorial/before-after sections need to render. Pure data —
 *  resolved from a generated `advertorial_pages` row or derived from PageData. */
export interface AdvertorialContent {
  variant: AdvertorialVariant;
  angleSlug: string | null;
  /** Brand-owned masthead, e.g. "THE SUPERFOODS REPORT" (advertorial only). */
  publication: string;
  sponsorLabel: string;
  /** Editorial serif hero headline. */
  headline: string;
  /** One-line standfirst under the headline. */
  dek: string;
  heroKind: AdvertorialHeroKind;
  heroImageUrl: string | null;
  heroCaption: string;
  /** Before/after transformation hero (before/after lander). */
  beforeImageUrl: string | null;
  afterImageUrl: string | null;
  /** Narrative chapter 1 (problem → mechanism/story → proof). */
  chapter: { heading: string; paragraphs: string[] };
  /** "N reasons why" listicle items (variant='reasons'). */
  reasons: ReasonItem[];
  rating: number;
  /** Review count, already display-formatted (actual + 10,000). */
  reviewCountDisplay: string;
}

/**
 * Format an ALREADY-bumped review total for display. `PageData.review_total_count`
 * already includes the +10,000 off-platform bump (storefront_off_platform_review_count)
 * — the same value the PDP renders — so just format it. Do NOT add the bump again
 * here (that double-bumped landers to actual + 20,000 vs the PDP's actual + 10,000).
 */
export function displayReviewCount(alreadyBumpedTotal: number): string {
  return Math.max(0, Math.round(alreadyBumpedTotal)).toLocaleString("en-US");
}

// Angle hook → hero kind. Testimonial/transformation/social-proof → the avatar
// holding-product shot; mechanism/curiosity/clinical → an ingredient shot.
const INGREDIENT_HOOKS = new Set([
  "contrarian",
  "secret_reveal",
  "enemy",
  "urgent_question",
  "problem_now",
  "visual_shock",
]);

export function heroKindForHook(hookSlug: string | null): "avatar" | "ingredient" {
  return hookSlug && INGREDIENT_HOOKS.has(hookSlug) ? "ingredient" : "avatar";
}

// Reviews that speak to the CORE desires — weight / appearance / being noticed.
// Used by the before/after lander's testimonial wall (and to anchor proof copy).
const WEIGHT_RE = /\b(weight|pounds?|lbs?|lost|losing|slim|trimm?er|size[sd]?|smaller|jeans|scale|inches?|figure)\b/i;
const APPEARANCE_RE = /\b(younger|skin|glow|complexion|wrinkles?|compliments?|confiden\w*|noticed|radiant)\b/i;

export function weightLossReviews(reviews: Review[], limit = 9): Review[] {
  const fiveStar = reviews.filter((r) => (r.rating ?? 0) >= 5);
  const onDesire = fiveStar.filter((r) => {
    const text = `${r.title || ""} ${r.body || ""} ${r.smart_quote || ""}`;
    return WEIGHT_RE.test(text) || APPEARANCE_RE.test(text);
  });
  // Prefer on-desire reviews; backfill with other 5★ so the wall is never empty.
  const picked = [...onDesire];
  for (const r of fiveStar) {
    if (picked.length >= limit) break;
    if (!picked.includes(r)) picked.push(r);
  }
  return picked.slice(0, limit);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

/** Re-sign an ad-tool storage path → fresh URL; pass public/external URLs through. */
async function resolveHeroUrl(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  // Bare ad-tool bucket path → short-lived signed URL.
  try {
    const admin = createAdminClient();
    const { data } = await admin.storage.from("ad-tool").createSignedUrl(ref, 60 * 60);
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

function mediaUrl(data: PageData, slot: string): string | null {
  const m = data.media_by_slot[slot];
  if (!m) return null;
  // MediaItem carries a url (public product-media bucket) in this codebase.
  const anyM = m as unknown as { url?: string | null; storage_path?: string | null };
  if (anyM.url) return anyM.url;
  if (anyM.storage_path && SUPABASE_URL) return `${SUPABASE_URL}/storage/v1/object/public/product-media/${anyM.storage_path}`;
  return null;
}

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * Resolve the advertorial/before-after top for a lander. Prefers a generated
 * `advertorial_pages` row (keyed by product_id + slug); falls back to deriving
 * an editorial top from the already-loaded PageData so the layout always renders.
 */
export async function loadAdvertorialContent(
  data: PageData,
  variant: AdvertorialVariant,
  angleSlug: string | null,
): Promise<AdvertorialContent> {
  const productId = data.product.id;
  let row: AdvertorialPageRow | null = null;
  if (angleSlug) {
    try {
      const admin = createAdminClient();
      const { data: r } = await admin
        .from("advertorial_pages")
        .select("*")
        .eq("product_id", productId)
        .eq("slug", angleSlug)
        .eq("variant", variant)
        .eq("status", "ready")
        .maybeSingle();
      row = (r as AdvertorialPageRow) || null;
    } catch {
      row = null; // table may not exist yet (pre-migration) — fall back
    }
  }
  return row ? rowToContent(data, variant, angleSlug, row) : fallbackContent(data, variant, angleSlug);
}

interface AdvertorialPageRow {
  slug: string;
  variant: string;
  publication: string | null;
  sponsor_label: string | null;
  headline: string | null;
  dek: string | null;
  hero_kind: string | null;
  hero_storage_path: string | null;
  hero_caption: string | null;
  chapter_heading: string | null;
  chapter_paragraphs: string[] | null;
  reasons: ReasonItem[] | null;
}

async function rowToContent(
  data: PageData,
  variant: AdvertorialVariant,
  angleSlug: string | null,
  row: AdvertorialPageRow,
): Promise<AdvertorialContent> {
  const fb = fallbackContent(data, variant, angleSlug);
  const heroFromRow = await resolveHeroUrl(row.hero_storage_path);
  return {
    variant,
    angleSlug,
    publication: row.publication || fb.publication,
    sponsorLabel: row.sponsor_label || fb.sponsorLabel,
    headline: row.headline || fb.headline,
    dek: row.dek || fb.dek,
    heroKind: (row.hero_kind as AdvertorialHeroKind) || fb.heroKind,
    heroImageUrl: heroFromRow || fb.heroImageUrl,
    heroCaption: row.hero_caption || fb.heroCaption,
    beforeImageUrl: fb.beforeImageUrl,
    afterImageUrl: fb.afterImageUrl,
    chapter: {
      heading: row.chapter_heading || fb.chapter.heading,
      paragraphs: row.chapter_paragraphs?.length ? row.chapter_paragraphs : fb.chapter.paragraphs,
    },
    reasons: row.reasons?.length ? row.reasons : fb.reasons,
    rating: fb.rating,
    reviewCountDisplay: fb.reviewCountDisplay,
  };
}

/** Derive a sensible "N reasons why" listicle from PageData when nothing is generated. */
function fallbackReasons(data: PageData, title: string): ReasonItem[] {
  const out: ReasonItem[] = [];
  for (const b of data.benefit_selections || []) {
    if (!b.benefit_name) continue;
    out.push({ heading: b.benefit_name, body: `${title} is built around ${b.benefit_name.toLowerCase()} — one of the reasons people over 50 are making the switch.` });
    if (out.length >= 6) break;
  }
  out.push({ heading: "It works the longer you drink it", body: `The difference isn't a quick jolt. It's what shows up over the weeks — in the mirror, on the scale, and in the compliments.` });
  out.push({ heading: "Backed by a money-back guarantee", body: `There's no risk in trying it. If it isn't for you, you're covered.` });
  return out.slice(0, 8);
}

/** Editorial top derived from PageData when no generated row exists. */
function fallbackContent(data: PageData, variant: AdvertorialVariant, angleSlug: string | null): AdvertorialContent {
  const title = data.product.title;
  const pc = data.page_content;
  const rating = Math.round(data.product.rating || 5);
  const before = mediaUrl(data, "before");
  const after = mediaUrl(data, "after");
  const avatar = mediaUrl(data, "lifestyle_1") || mediaUrl(data, "hero");
  const ingredient =
    Object.keys(data.media_by_slot).find((s) => s.startsWith("ingredient_")) ?? null;
  const ingredientUrl = ingredient ? mediaUrl(data, ingredient) : null;
  const reasons = fallbackReasons(data, title);

  if (variant === "reasons") {
    const ing: AdvertorialHeroKind = ingredientUrl ? "ingredient" : "avatar";
    return {
      variant, angleSlug,
      publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED",
      headline: "8 Reasons Why People Over 50 Are Switching Their Morning Coffee",
      dek: `It looks like ordinary coffee. Here's why it isn't.`,
      heroKind: ing,
      heroImageUrl: ing === "ingredient" ? ingredientUrl : avatar,
      heroCaption: `${title}.`,
      beforeImageUrl: before, afterImageUrl: after,
      chapter: { heading: "", paragraphs: [] },
      reasons,
      rating, reviewCountDisplay: displayReviewCount(data.review_total_count || 0),
    };
  }

  if (variant === "beforeafter") {
    return {
      variant,
      angleSlug,
      publication: "REAL RESULTS",
      sponsorLabel: "SPONSORED",
      headline: "The transformation people over 50 are talking about",
      dek: "Real customers. Real photos. One simple change to their morning.",
      heroKind: "beforeafter",
      heroImageUrl: after || avatar,
      heroCaption: `Real ${title} customers.`,
      beforeImageUrl: before,
      afterImageUrl: after,
      chapter: {
        heading: "What changed",
        paragraphs: [
          pc?.mechanism_copy?.split(/\n\n+/)[0] ||
            `They didn't overhaul their lives. They swapped one cup — ${title} — and let it do the quiet work.`,
        ],
      },
      reasons,
      rating,
      reviewCountDisplay: displayReviewCount(data.review_total_count || 0),
    };
  }

  const heroKind: AdvertorialHeroKind = ingredientUrl && !avatar ? "ingredient" : "avatar";
  const mech = (pc?.mechanism_copy || "").split(/\n\n+/).filter(Boolean);
  return {
    variant,
    angleSlug,
    publication: "THE SUPERFOODS REPORT",
    sponsorLabel: "SPONSORED",
    headline: pc?.hero_headline || `The Morning Coffee People Over 50 Are Switching To`,
    dek: pc?.hero_subheadline || `It looks like ordinary coffee. The results people report are anything but.`,
    heroKind,
    heroImageUrl: heroKind === "ingredient" ? ingredientUrl : avatar,
    heroCaption: `${title}.`,
    beforeImageUrl: before,
    afterImageUrl: after,
    chapter: {
      heading: "Why people are making the switch",
      paragraphs: mech.length
        ? mech.slice(0, 2)
        : [
            `A growing number of people over 50 are quietly swapping their morning routine for ${title} — and talking about how they look and feel because of it.`,
            `The difference isn't a quick jolt of energy. It's what shows up over the weeks: in the mirror, on the scale, and in the compliments.`,
          ],
    },
    reasons,
    rating,
    reviewCountDisplay: displayReviewCount(data.review_total_count || 0),
  };
}

// ── Generator (Opus copy + hero auto-select + persist) ───────────────────────

interface AngleRow {
  id: string;
  hook_slug: string | null;
  lf8_slot: number | null;
  lead_benefit_anchor: string | null;
  hook_one_liner: string | null;
  pain_now: string | null;
  desired_outcome: string | null;
  enemy: string | null;
}

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Stable per-product URL slug for an angle's lander (readable + unique). */
export function slugForAngle(angle: { id: string; hook_slug: string | null }): string {
  const base = slugify(angle.hook_slug || "angle");
  return `${base}-${angle.id.slice(0, 8)}`;
}

/** Pull the ad-tool bucket PATH out of a (possibly signed) hero URL so we persist
 *  a re-signable path, not an expiring signed URL. */
function extractAdToolPath(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = ref.match(/\/(?:sign|public)\/ad-tool\/([^?]+)/) || ref.match(/\/ad-tool\/([^?]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (!/^https?:\/\//i.test(ref)) return ref; // already a bare path
  return null; // external/expiring URL we can't re-sign — fall back to media
}

interface NarrativeCopy {
  publication: string;
  sponsorLabel: string;
  headline: string;
  dek: string;
  heroCaption: string;
  chapterHeading: string;
  chapterParagraphs: string[];
  reasons: ReasonItem[]; // populated for the "reasons" listicle variant
}

/** This variant's headline always leads with "8 Reasons Why" (Dylan, 2026-06-16). */
function eightReasonsHeadline(h: string): string {
  const t = (h || "").trim();
  if (/^8\s+reasons\s+why/i.test(t)) return t;
  const subject = t.replace(/^\d+\s+reasons(\s+why)?\b[:\s-]*/i, "").trim();
  return `8 Reasons Why ${subject || "People Over 50 Are Switching Their Morning Coffee"}`;
}

/** Deterministic listicle from PI — used as the reasons-variant fallback. */
function reasonsFallback(inputs: AngleGeneratorInput): ReasonItem[] {
  const title = inputs.product_title;
  const out: ReasonItem[] = [];
  for (const b of (inputs.lead_benefits || [])) {
    if (!b.name) continue;
    out.push({ heading: b.name, body: `${title} is built around ${b.name.toLowerCase()} — one of the core reasons people over 50 are making the switch.` });
    if (out.length >= 5) break;
  }
  for (const s of (inputs.ingredient_science || [])) {
    if (!s.ingredient_name || !s.benefit_headline) continue;
    out.push({ heading: s.ingredient_name, body: s.benefit_headline });
    if (out.length >= 7) break;
  }
  out.push({ heading: "It works the longer you drink it", body: "The difference isn't a quick jolt — it's what shows up over the weeks, in the mirror and on the scale." });
  return out.slice(0, 8);
}

function narrativeFallback(inputs: AngleGeneratorInput, angle: AngleRow | null, variant: AdvertorialVariant): NarrativeCopy {
  const title = inputs.product_title;
  const lead = angle?.hook_one_liner || inputs.hero_headline || "";
  if (variant === "beforeafter") {
    return {
      publication: "REAL RESULTS",
      sponsorLabel: "SPONSORED",
      headline: lead || "The transformation people over 50 are talking about",
      dek: "Real customers. Real photos. One simple change to their morning.",
      heroCaption: `Real ${title} customers.`,
      chapterHeading: "What changed",
      chapterParagraphs: [
        `They didn't overhaul their lives. They swapped one cup — ${title} — and let it do the quiet work, week after week.`,
      ],
      reasons: [],
    };
  }
  if (variant === "reasons") {
    const reasons = reasonsFallback(inputs);
    return {
      publication: "THE SUPERFOODS REPORT",
      sponsorLabel: "SPONSORED",
      // Clean template (NOT the product's hero_headline — "8 Reasons Why Brew. Sip…" reads broken).
      headline: "8 Reasons Why People Over 50 Are Switching Their Morning Coffee",
      dek: `It looks like ordinary coffee. Here's why it isn't.`,
      heroCaption: `${title}.`,
      chapterHeading: "",
      chapterParagraphs: [],
      reasons,
    };
  }
  return {
    publication: "THE SUPERFOODS REPORT",
    sponsorLabel: "SPONSORED",
    headline: lead || inputs.hero_headline || `The Morning Coffee People Over 50 Are Switching To`,
    dek: inputs.hero_subheadline || `It looks like ordinary coffee. The results people report are anything but.`,
    heroCaption: `${title}.`,
    chapterHeading: "Why people are making the switch",
    chapterParagraphs: [
      `A growing number of people over 50 are quietly swapping their morning routine for ${title} — and talking about how they look and feel because of it.`,
      `The difference isn't a quick jolt of energy. It's what shows up over the weeks: in the mirror, on the scale, and in the compliments.`,
    ],
    reasons: [],
  };
}

async function callOpus(workspaceId: string, prompt: string): Promise<Record<string, unknown> | null> {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    await logAiUsage({ workspaceId, model: OPUS_MODEL, usage: out.usage, purpose: "advertorial_lander_copy", ticketId: null }).catch(() => {});
    const m = (out?.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Generate the editorial headline + dek + chapter-1 narrative for a lander —
 * the SAME angle + PI tiers that drive the ad, so the lander is scent-matched by
 * construction. PI-anchored with a deterministic fallback; banned-word-gated via
 * the existing ad validator so claims stay anchored.
 */
export async function generateAdvertorialNarrative(
  workspaceId: string,
  inputs: AngleGeneratorInput,
  angle: AngleRow | null,
  variant: AdvertorialVariant,
  script: string,
  bannedWords: string[],
): Promise<NarrativeCopy> {
  const fb = narrativeFallback(inputs, angle, variant);
  const benefits = (inputs.lead_benefits || []).map((b) => b.name).filter(Boolean).slice(0, 6);
  const science = (inputs.ingredient_science || []).map((s) => `${s.ingredient_name}: ${s.benefit_headline}`).filter(Boolean).slice(0, 5);
  const reviews = (inputs.proof_quotes || []).slice(0, 4).map((q) => `"${q.quote}"`);

  // ── "N reasons why" listicle variant — distinct prompt + JSON shape. ──
  if (variant === "reasons") {
    const prompt = `You write the top of a "reasons why" listicle landing page for a COLD 50+ audience — it continues the scent of an ingredient-breakdown ad they just clicked ("here's exactly what's inside / why it works"). It reads like a trustworthy health-magazine listicle, NOT a loud DTC page. Product: "${inputs.product_title}".

ANCHOR every reason to the CORE desires, in order: weight loss, fighting aging, being the best version of yourself, being noticed/liked (social approval). NEVER lead with functional/secondary benefits (energy, "no jitters", "no 2pm crash", focus) — energy is at most a supporting mechanism.

Lead angle (honor it): hook "${angle?.hook_one_liner || ""}", anchor benefit (verbatim) "${angle?.lead_benefit_anchor || ""}", pain "${angle?.pain_now || ""}", desired outcome "${angle?.desired_outcome || ""}".
Truthful inputs (no invented/medical claims): benefits ${benefits.join("; ") || "(none)"}; ingredient science ${science.join("; ") || "(none)"}; guarantee ${inputs.guarantee_copy || "(none)"}; real review quotes ${reviews.join(" ") || "(none)"}.

Write with CONFIDENCE — these are real results customers ARE reporting, not possibilities. NEVER hedge: do not use "may", "might", "could", "may help", "can help", "helps support", or "studied for" in the headings. Frame the desire-led reasons as what real customers are experiencing/reporting, grounded in the real review quotes (e.g. heading "Customers Are Losing Weight" or "Drinkers Report Smaller Waistlines", body "One customer dropped 30 lbs in four months after switching her morning cup."). State it directly. (Ingredient-mechanism reasons may still describe what an ingredient does, plainly.)

Write EXACTLY 8 reasons. Each reason: a short punchy heading (3-7 words) + ONE short sentence body. American English, plain, no hype. Do NOT use these words: ${bannedWords.join(", ") || "(none)"}.

Return ONLY JSON:
{"publication":"brand-owned masthead, e.g. THE SUPERFOODS REPORT","headline":"MUST start with the exact words '8 Reasons Why', e.g. '8 Reasons Why People Over 50 Are Switching Their Morning Coffee'","dek":"one-sentence standfirst","heroCaption":"short italic photo caption","reasons":[{"heading":"reason heading","body":"one short sentence"}]}`;
    const j = await callOpus(workspaceId, prompt);
    if (!j) return fb;
    const reasons: ReasonItem[] = (Array.isArray(j.reasons) ? j.reasons : [])
      .map((r: unknown) => {
        const o = (r || {}) as { heading?: unknown; body?: unknown };
        return { heading: String(o.heading || "").trim(), body: String(o.body || "").trim() };
      })
      .filter((r: ReasonItem) => r.heading && r.body)
      .slice(0, 8);
    if (reasons.length < 4) return fb;
    const out: NarrativeCopy = {
      publication: String(j.publication || fb.publication).trim(),
      sponsorLabel: fb.sponsorLabel,
      headline: eightReasonsHeadline(String(j.headline || fb.headline)),
      dek: String(j.dek || fb.dek).trim(),
      heroCaption: String(j.heroCaption || fb.heroCaption).trim(),
      chapterHeading: "",
      chapterParagraphs: [],
      reasons,
    };
    // Editorial listicle copy legitimately uses "supports/helps/natural" ("supports
    // immune function" is trustworthy 50+ language) — the DR soft-word defaults are
    // for punchy spoken hooks, not this. Gate only on a workspace's EXPLICIT banned
    // words, never the soft-word defaults.
    const soft = new Set(DEFAULT_BANNED_WORDS.map((w) => w.toLowerCase()));
    const hardBanned = bannedWords.filter((w) => !soft.has(w.toLowerCase()));
    const blob = [out.headline, out.dek, ...reasons.flatMap((r) => [r.heading, r.body])].join(" ").toLowerCase();
    if (hardBanned.some((w) => w && blob.includes(w.toLowerCase()))) return fb;
    return out;
  }

  const prompt = `You write the editorial TOP of an advertorial landing page for a COLD 50+ audience. It must read like a trustworthy health-magazine article continuing from an ad they just clicked — NOT a loud DTC page (the un-ad look is the whole conversion mechanism). Product: "${inputs.product_title}".

ANCHOR everything to the CORE desires, in order: weight loss, fighting aging, being the best version of yourself, being noticed/liked (social approval). NEVER lead with functional/secondary benefits (energy, "no jitters", "no 2pm crash", focus).

Lead angle (honor it): hook "${angle?.hook_one_liner || ""}", anchor benefit (verbatim) "${angle?.lead_benefit_anchor || ""}", pain "${angle?.pain_now || ""}", desired outcome "${angle?.desired_outcome || ""}".
Truthful inputs (no invented/medical claims): benefits ${benefits.join("; ") || "(none)"}; ingredient science ${science.join("; ") || "(none)"}; guarantee ${inputs.guarantee_copy || "(none)"}; real review quotes ${reviews.join(" ") || "(none)"}.
The matching ad's spoken script (for tone): """${(script || "").slice(0, 600)}"""
${variant === "beforeafter" ? "This is a BEFORE/AFTER lander — keep specific weight-loss numbers OUT of the page's own claims (those belong in real testimonial quotes)." : ""}

Write the editorial top. The chapter-1 narrative goes problem → mechanism/story → proof, 2 short paragraphs. American English, plain, no hype. Do NOT use these words: ${bannedWords.join(", ") || "(none)"}.

Return ONLY JSON:
{"publication":"brand-owned masthead, e.g. THE SUPERFOODS REPORT","headline":"editorial serif hero headline, ~10-14 words, curiosity/benefit-led, no brand name first","dek":"one-sentence standfirst","heroCaption":"short italic photo caption","chapterHeading":"short chapter heading","chapterParagraphs":["paragraph 1","paragraph 2"]}`;

  const j = await callOpus(workspaceId, prompt);
  if (!j) return fb;
  const paras = (Array.isArray(j.chapterParagraphs) ? j.chapterParagraphs : []).map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 3);
  const out: NarrativeCopy = {
    publication: String(j.publication || fb.publication).trim(),
    sponsorLabel: fb.sponsorLabel,
    headline: String(j.headline || fb.headline).trim(),
    dek: String(j.dek || fb.dek).trim(),
    heroCaption: String(j.heroCaption || fb.heroCaption).trim(),
    chapterHeading: String(j.chapterHeading || fb.chapterHeading).trim(),
    chapterParagraphs: paras.length ? paras : fb.chapterParagraphs,
    reasons: [],
  };
  // Banned-word gate (lenient — the opener/length codes are spoken-script specific).
  try {
    const res = validateAdScript([out.headline, out.dek, ...out.chapterParagraphs].join(" "), null, inputs, { bannedWords });
    if (res.violations.some((v) => v.severity === "fatal" && v.code === "banned_word")) return fb;
  } catch {
    /* validator is best-effort */
  }
  return out;
}

export interface GeneratedLander {
  variant: AdvertorialVariant;
  slug: string;
  url_path: string;
}

/**
 * The reasons-listicle hero: a Nano Banana Pro **Amazing Coffee** image — the
 * product's REAL isolated pouch composited into a warm lifestyle coffee scene
 * (same approach as the auto-blog hero, [[blog/generate-images]]). Compressed to
 * WebP + uploaded to the public product-media bucket; reused per-product so the
 * generation cost is paid once. Returns a public URL (the lander reader passes
 * http(s) heroes straight through). Null if the product has no isolated pouch or
 * generation fails (the fallback ingredient/avatar hero still renders).
 */
const REASONS_HERO_BUCKET = "product-media";
export async function ensureReasonsHero(workspaceId: string, productId: string): Promise<string | null> {
  const admin = createAdminClient();
  const [{ data: product }, { data: variant }] = await Promise.all([
    admin.from("products").select("handle, title").eq("id", productId).maybeSingle(),
    admin.from("product_variants").select("isolated_image_url").eq("product_id", productId).not("isolated_image_url", "is", null).limit(1).maybeSingle(),
  ]);
  const handle = product?.handle;
  const isolated = variant?.isolated_image_url as string | undefined;
  if (!handle || !isolated) return null;
  const path = `workspaces/${workspaceId}/landers/${handle}/reasons-hero.webp`;
  const publicUrl = admin.storage.from(REASONS_HERO_BUCKET).getPublicUrl(path).data.publicUrl;
  // Reuse if already generated.
  try { const head = await fetch(publicUrl, { method: "HEAD" }); if (head.ok) return publicUrl; } catch { /* generate */ }
  const prompt = `Photorealistic lifestyle product photograph for "${product?.title || "a superfood coffee"}". Composite the EXACT product pouch shown in the first image (keep its packaging artwork, colors and text sharp and accurate) standing on a warm wooden kitchen counter beside a freshly poured mug of creamy coffee with gentle steam, a scatter of roasted coffee beans and a soft hint of green herbs, bathed in soft golden morning light, shallow depth of field, inviting and premium editorial food photography. No text overlays, no logos other than the pouch, no people.`;
  try {
    const { buffer: raw } = await generateNanoBananaProCombine({ workspaceId, prompt, imageUrls: [isolated], aspectRatio: "16:9" });
    const { buffer } = await compressToWebp(raw, { maxWidth: 1600, quality: 82 });
    const { error } = await admin.storage.from(REASONS_HERO_BUCKET).upload(path, buffer, { contentType: "image/webp", upsert: true });
    if (error) return null;
    return publicUrl;
  } catch {
    return null;
  }
}

/**
 * Generate + persist the ad-matched lander(s) for a campaign that reached `ready`.
 * Always builds the advertorial lander; additionally builds the before/after
 * lander when the product has real before/after media (weight-loss scent). Keyed
 * by (product_id, slug) so it's reused across all campaigns/ads of that angle.
 */
export async function generateAdvertorialPagesForCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<{ ok: boolean; landers: GeneratedLander[]; reason?: string }> {
  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("ad_campaigns")
    .select("id, product_id, angle_id, hero_image_url, script_text")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!campaign?.product_id) return { ok: false, landers: [], reason: "no_product" };

  let angle: AngleRow | null = null;
  if (campaign.angle_id) {
    const { data: a } = await admin
      .from("product_ad_angles")
      .select("id, hook_slug, lf8_slot, lead_benefit_anchor, hook_one_liner, pain_now, desired_outcome, enemy")
      .eq("id", campaign.angle_id)
      .maybeSingle();
    angle = (a as AngleRow) || null;
  }

  const [inputs, ws, mediaRes] = await Promise.all([
    loadAngleInputs(campaign.product_id),
    admin.from("workspaces").select("ad_tool_settings").eq("id", workspaceId).single(),
    admin.from("product_media").select("slot").eq("product_id", campaign.product_id),
  ]);
  const settings = resolveAdToolSettings(ws.data?.ad_tool_settings);
  const slots = new Set((mediaRes.data || []).map((m) => m.slot));
  const hasBeforeAfter = slots.has("before") && slots.has("after");

  const slug = angle ? slugForAngle(angle) : slugify(`${inputs.product_title}-default`);
  // Avatar hero = a believable avatar-holding-product shot. Prefer this campaign's
  // own hero; if it has none (e.g. seeded static campaigns), borrow one from any of
  // the product's ad campaigns. Never fall back to a UGC lifestyle model — a real
  // slim model under "lost 30 lbs" copy reads false; a 50s avatar holding the product
  // is believable.
  let avatarPath = extractAdToolPath(campaign.hero_image_url);
  if (!avatarPath) {
    const { data: heroCamp } = await admin
      .from("ad_campaigns")
      .select("hero_image_url")
      .eq("workspace_id", workspaceId)
      .eq("product_id", campaign.product_id)
      .not("hero_image_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    avatarPath = extractAdToolPath((heroCamp as { hero_image_url?: string | null })?.hero_image_url || null);
  }

  // Which variant(s) to generate. Advertorial + reasons-listicle always; before/
  // after when the product has the real transformation media to back it.
  const variants: AdvertorialVariant[] = hasBeforeAfter
    ? ["advertorial", "reasons", "beforeafter"]
    : ["advertorial", "reasons"];
  const landers: GeneratedLander[] = [];

  for (const variant of variants) {
    const copy = await generateAdvertorialNarrative(workspaceId, inputs, angle, variant, campaign.script_text || "", settings.banned_words || []);
    // The reasons listicle uses a generated Nano Banana Pro Amazing Coffee hero.
    const heroKind: AdvertorialHeroKind =
      variant === "beforeafter" ? "beforeafter" : variant === "reasons" ? "ingredient" : heroKindForHook(angle?.hook_slug || null);
    // Persist a re-signable hero path: avatar = the campaign hero; reasons = the
    // generated lifestyle coffee hero (public URL). beforeafter resolves from
    // product_media at render.
    const heroStoragePath =
      variant === "reasons" ? await ensureReasonsHero(workspaceId, campaign.product_id)
      : heroKind === "avatar" ? avatarPath
      : null;
    const rowSlug = variant === "beforeafter" ? `${slug}-ba` : variant === "reasons" ? `${slug}-reasons` : slug;

    await admin
      .from("advertorial_pages")
      .upsert(
        {
          workspace_id: workspaceId,
          product_id: campaign.product_id,
          angle_id: campaign.angle_id,
          campaign_id: campaignId,
          slug: rowSlug,
          variant,
          publication: copy.publication,
          sponsor_label: copy.sponsorLabel,
          headline: copy.headline,
          dek: copy.dek,
          hero_kind: heroKind,
          hero_storage_path: heroStoragePath,
          hero_caption: copy.heroCaption,
          chapter_heading: copy.chapterHeading,
          chapter_paragraphs: copy.chapterParagraphs,
          reasons: copy.reasons,
          status: "ready",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,product_id,slug" },
      );
    landers.push({ variant, slug: rowSlug, url_path: `?variant=${variant}&angle=${encodeURIComponent(rowSlug)}` });
  }

  return { ok: true, landers };
}

/**
 * Build the public destination URL for a campaign's advertorial lander, so the
 * Meta publish step can point the ad at its scent-matched page by construction.
 * Prefers the generated advertorial_pages slug for the campaign's product/angle;
 * returns null when there's no lander to point at (caller keeps the PDP/override).
 */
export async function advertorialLanderUrl(workspaceId: string, campaignId: string, variant: AdvertorialVariant = "advertorial"): Promise<string | null> {
  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("ad_campaigns")
    .select("product_id, angle_id")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!campaign?.product_id) return null;

  // The lander for this product + variant (prefer the campaign's angle). The
  // before/after row is stored under slug "{base}-ba"; read its actual slug so
  // the URL angle param matches what loadAdvertorialContent() queries.
  let pageQuery = admin
    .from("advertorial_pages")
    .select("slug, angle_id, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("product_id", campaign.product_id)
    .eq("variant", variant)
    .order("updated_at", { ascending: false });
  if (campaign.angle_id) pageQuery = pageQuery.eq("angle_id", campaign.angle_id);
  const { data: page } = await pageQuery.limit(1).maybeSingle();
  if (!page?.slug) return null;

  const [{ data: product }, { data: ws }] = await Promise.all([
    admin.from("products").select("handle").eq("id", campaign.product_id).maybeSingle(),
    admin.from("workspaces").select("storefront_domain, storefront_slug").eq("id", workspaceId).maybeSingle(),
  ]);
  if (!product?.handle) return null;

  const qs = `?variant=${variant}&angle=${encodeURIComponent(page.slug)}`;
  if (ws?.storefront_domain) return `https://${ws.storefront_domain}/${product.handle}${qs}`;
  if (ws?.storefront_slug) return `https://shopcx.ai/store/${ws.storefront_slug}/${product.handle}${qs}`;
  return null;
}

/**
 * Scent-match invariant helper (attribution-sensor-recalibration Phase 2).
 *
 * Given an operator-supplied destination URL and the campaign's
 * `advertorialLanderUrl` result, ensure the final URL carries BOTH `?angle=`
 * and `?variant=` — the params the Phase-2 attribution sensor uses to resolve
 * a click → lander → variant. Missing params on the destination are copied
 * from the lander (source of truth for scent-match); params already present
 * on the destination win.
 *
 * Pure — no I/O. Returns the destination unchanged when either URL is
 * malformed (URL constructor throws), or when the lander doesn't carry the
 * expected params (nothing to derive from).
 */
export function appendScentMatchParams(destinationUrl: string, landerUrl: string | null): string {
  if (!destinationUrl || !landerUrl) return destinationUrl;
  let dest: URL;
  let src: URL;
  try { dest = new URL(destinationUrl); } catch { return destinationUrl; }
  try { src = new URL(landerUrl); } catch { return destinationUrl; }
  const angle = src.searchParams.get("angle");
  const variant = src.searchParams.get("variant");
  if (!dest.searchParams.has("angle") && angle) dest.searchParams.set("angle", angle);
  if (!dest.searchParams.has("variant") && variant) dest.searchParams.set("variant", variant);
  return dest.toString();
}

/** True when a destination URL carries BOTH the `angle` and `variant` scent-match params. */
export function hasScentMatchParams(destinationUrl: string): boolean {
  if (!destinationUrl) return false;
  try {
    const u = new URL(destinationUrl);
    return u.searchParams.has("angle") && u.searchParams.has("variant");
  } catch {
    return false;
  }
}
