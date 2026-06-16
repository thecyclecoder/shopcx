/**
 * Ad tool — the cold-50+ STATIC archetype system ("killer statics").
 *
 * Five trust-first archetypes, each a Remotion still rendered in BOTH 4:5 (feed)
 * and 9:16 (stories/reels), auto-built from Product Intelligence + existing ad
 * assets — no manual design:
 *   - advertorial   → editorial "article" (serif). Hero = avatar OR ingredient.
 *   - testimonial   → real 5★ review + a lifestyle face + isolated product.
 *   - authority     → real endorser (photo + quote) + isolated product.
 *   - big_claim     → contrarian hook poster on a dark bg + isolated product.
 *   - before_after  → real customer before/after photos.
 *
 * This file hydrates assets, generates/reuses hero imagery, generates copy
 * (advertorial / big_claim / before_after via Opus; testimonial / authority use
 * REAL review / endorsement text verbatim), and returns composition-ready props
 * with FRESH signed URLs (Lambda-safe). See docs/brain/specs/killer-statics.md.
 *
 * Image rules (hard — Dylan): NEVER product-on-white. Product images are the
 * isolated transparent cutout. Advertorial heroes are avatars or ingredient shots
 * only. Use REAL product_media (endorser headshot, before/after) when present.
 * Review counts display as actual + 10,000.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrl, uploadBuffer } from "@/lib/ad-storage";
import { loadAngleInputs } from "@/lib/ad-angles";
import { generateNanoBananaProCombine } from "@/lib/gemini";
import type { AngleGeneratorInput, ProductAdAngle } from "@/lib/ad-types";
import { DEFAULT_BRAND } from "@/lib/ad-static";
import { generateAdvertorialCopy, generateBigClaimCopy, generateBeforeAfterCopy, generateIngredientBreakdownCopy, type AdvertorialHeroKind } from "@/lib/ad-statics-copy";

export type KillerArchetype = "advertorial" | "testimonial" | "authority" | "big_claim" | "before_after" | "ingredient_breakdown";
export const KILLER_ARCHETYPES: KillerArchetype[] = ["advertorial", "testimonial", "authority", "big_claim", "before_after", "ingredient_breakdown"];

/** Cold 50+ defaults to the trust set; big_claim/before_after are more overt tests.
 *  ingredient_breakdown is trust-first (legible, "here's exactly what's inside"). */
export const TRUST_ARCHETYPES: KillerArchetype[] = ["advertorial", "testimonial", "authority", "ingredient_breakdown"];

export const KILLER_COMPOSITION: Record<KillerArchetype, string> = {
  advertorial: "StaticAdvertorial",
  testimonial: "StaticTestimonial",
  authority: "StaticAuthority",
  big_claim: "StaticBigClaim",
  before_after: "StaticBeforeAfter",
  ingredient_breakdown: "StaticIngredientBreakdown",
};

export const KILLER_ARCHETYPE_LABELS: Record<KillerArchetype, string> = {
  advertorial: "Advertorial (editorial)",
  testimonial: "Testimonial (face)",
  authority: "Authority (expert)",
  big_claim: "Big claim (hook)",
  before_after: "Before / after",
  ingredient_breakdown: "Ingredient breakdown",
};

/** Both formats, every time. 9:16 carries Meta safe-zone insets. */
export const KILLER_FORMATS: Array<{ format: string; w: number; h: number; safeTopPct: number; safeBottomPct: number }> = [
  { format: "feed_4x5", w: 1080, h: 1350, safeTopPct: 0, safeBottomPct: 0 },
  { format: "stories_9x16", w: 1080, h: 1920, safeTopPct: 0.08, safeBottomPct: 0.14 },
];

/** Archetype → default landing-page kind (operator can override at publish). */
export type LanderKind = "pdp" | "advertorial" | "before_after" | "reasons";
export const ARCHETYPE_LANDER: Record<KillerArchetype, LanderKind> = {
  advertorial: "advertorial",
  testimonial: "pdp",
  authority: "pdp",
  big_claim: "pdp",
  before_after: "before_after",
  // ingredient_breakdown → the "reasons" listicle continues the "what's inside" scent.
  ingredient_breakdown: "reasons",
};

const ACCENT = "#B0451C";

// ── Signing ──────────────────────────────────────────────────────────────────
/** Re-sign an ad-tool ref for a fresh fetch; pass through other public URLs (product-media). */
export async function signAdToolRef(ref?: string | null): Promise<string | null> {
  if (!ref) return null;
  if (/^https?:\/\//.test(ref)) {
    const m = ref.match(/\/ad-tool\/(.+?)(\?|$)/);
    if (m) { try { return await signedUrl(decodeURIComponent(m[1])); } catch { return null; } }
    return ref; // public product-media / storefront URL — usable as-is
  }
  try { return await signedUrl(ref); } catch { return null; } // bare ad-tool path
}

/** Reuse a generated hero if it exists in the ad-tool bucket, else generate + persist. */
async function ensureGeneratedImage(workspaceId: string, key: string, prompt: string, aspect: "1:1" | "4:5"): Promise<string | null> {
  try { return await signedUrl(key); } catch { /* not present yet */ }
  try {
    const { buffer, mimeType } = await generateNanoBananaProCombine({ workspaceId, prompt, imageUrls: [], aspectRatio: aspect });
    await uploadBuffer(key, buffer, mimeType);
    return await signedUrl(key);
  } catch {
    return null; // SafeImg hides a missing hero — the still still renders
  }
}

// ── Ingredient-breakdown "split bag cutaway" hero ────────────────────────────
// Fuses the real isolated bag + real ingredient photos into a sliced-open pouch
// (left = intact bag, right = ingredients stacked inside). Nano Banana won't emit
// a real alpha channel (it bakes a checkerboard), so we generate on flat magenta,
// chroma-key it to true transparency, and trim the border so the bag fills its
// column. Reused per-product → no repeat spend.
const BREAKDOWN_HERO_PROMPT =
  `Using the FIRST image (a stand-up coffee pouch) and the following ingredient reference photos, create ONE photorealistic product hero. The pouch stands upright, centered, FULLY in frame (do not crop its packaging text). Its RIGHT HALF is rendered as a clean vertical cross-section "cutaway" — as if sliced open — revealing the real ingredients densely stacked INSIDE the bag, from top to bottom: pale cluster mushrooms, reddish-orange cordyceps, sliced brown mushrooms, light woody roots, bright green matcha powder, then roasted coffee beans at the very bottom. Keep the LEFT HALF as the actual intact pouch with its original packaging artwork and text sharp and legible. Warm soft studio lighting that matches the pouch. No added text, no labels, no shadow. CRITICAL: place the pouch on a SOLID FLAT PURE MAGENTA background, hex #FF00FF, perfectly even edge to edge — no gradient, checkerboard, texture or other objects — so it can be cleanly keyed out.`;

async function chromaKeyAndTrim(buf: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 120 && b > 120 && g < 130 && r - g > 45 && b - g > 45) {
      data[i + 3] = 0; // magenta background → transparent
    } else if (r - g > 25 && b - g > 25 && g < 170) {
      const spill = Math.min(r, b) - g; // anti-aliased fringe → ramp alpha + neutralise pink
      data[i + 3] = Math.max(0, Math.min(255, 255 - spill * 3));
      data[i + 1] = Math.round((r + b) / 2 * 0.6 + g * 0.4);
    }
  }
  return sharp(data, { raw: { width, height, channels } }).trim({ threshold: 12 }).png().toBuffer();
}

async function ensureBreakdownHero(workspaceId: string, productId: string, assets: KillerAssets): Promise<string | null> {
  const key = `statics/${productId}/breakdown-hero.png`;
  try { return await signedUrl(key); } catch { /* not present yet */ }
  const bag = assets.isolatedProductUrl;
  if (!bag) return null; // no isolated cutout → no faithful cutaway (SafeImg hides it)
  const ingRefs = Object.keys(assets.media)
    .filter((k) => k.startsWith("ingredient_") && assets.media[k])
    .slice(0, 5)
    .map((k) => assets.media[k]);
  try {
    const { buffer } = await generateNanoBananaProCombine({ workspaceId, prompt: BREAKDOWN_HERO_PROMPT, imageUrls: [bag, ...ingRefs], aspectRatio: "3:4" });
    const keyed = await chromaKeyAndTrim(buffer);
    await uploadBuffer(key, keyed, "image/png");
    return await signedUrl(key);
  } catch {
    return null;
  }
}

// ── Assets ─────────────────────────────────────────────────────────────────--
export interface KillerAssets {
  productTitle: string;
  inputs: AngleGeneratorInput;
  reviews: Array<{ reviewer_name: string | null; rating: number; body: string | null; smart_quote: string | null; verified_purchase: boolean | null }>;
  endorsement: { name: string; title: string; quote: string; bullets: string[] } | null;
  isolatedProductUrl: string | null; // public transparent cutout
  media: Record<string, string>; // product_media slot → public url
  heroRefs: string[]; // ad_campaigns.hero_image_url candidates (avatar holding-product)
  badges: string[];
  reviewCountDisplay: string; // real + 10,000
  rating: number;
  ingredientNames: string[]; // real product_ingredients, display order (for the breakdown poster)
}

function normalizeBadges(inp: AngleGeneratorInput): string[] {
  const pool = [...(inp.credibility?.certifications || []), ...(inp.credibility?.allergen_free || [])]
    .map((s) => String(s).trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of pool) {
    const k = b.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b.length > 18 ? b.slice(0, 18) : b);
    if (out.length >= 4) break;
  }
  return out.length ? out : ["Non-GMO", "3rd-Party Tested", "Made in USA", "Sugar Free"];
}

export async function loadKillerAssets(productId: string): Promise<KillerAssets> {
  const admin = createAdminClient();
  const inputs = await loadAngleInputs(productId);

  const [reviewsRes, pageRes, mediaRes, heroRes, ingRes] = await Promise.all([
    admin
      .from("product_reviews")
      .select("reviewer_name, rating, body, smart_quote, verified_purchase, featured")
      .eq("product_id", productId)
      .gte("rating", 5)
      .order("featured", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(8),
    admin
      .from("product_page_content")
      .select("endorsements")
      .eq("product_id", productId)
      .eq("status", "published")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("product_media").select("slot, url, webp_1080_url").eq("product_id", productId),
    admin.from("ad_campaigns").select("hero_image_url, scene_style").eq("product_id", productId).not("hero_image_url", "is", null).order("created_at", { ascending: false }).limit(8),
    admin.from("product_ingredients").select("name, display_order").eq("product_id", productId).order("display_order", { ascending: true }),
  ]);

  const endos = Array.isArray(pageRes.data?.endorsements) ? (pageRes.data!.endorsements as any[]) : [];
  const endorsement = endos[0]
    ? { name: endos[0].name || "", title: endos[0].title || "", quote: endos[0].quote || "", bullets: Array.isArray(endos[0].bullets) ? endos[0].bullets : [] }
    : null;

  const media: Record<string, string> = {};
  for (const m of mediaRes.data || []) {
    if (!m.slot) continue;
    const url = m.webp_1080_url || m.url;
    if (url) media[m.slot] = url;
  }

  const realCount = inputs.credibility?.review_count ?? 0;
  return {
    productTitle: inputs.product_title || "the product",
    inputs,
    reviews: (reviewsRes.data as KillerAssets["reviews"]) || [],
    endorsement,
    isolatedProductUrl: inputs.variant_isolated_image_url || null,
    media,
    heroRefs: (heroRes.data || []).map((c) => c.hero_image_url as string).filter(Boolean),
    badges: normalizeBadges(inputs),
    reviewCountDisplay: (realCount + 10000).toLocaleString("en-US"),
    rating: Math.min(5, Math.max(4, Math.round(inputs.credibility?.review_avg || 5))),
    ingredientNames: (ingRes.data || []).map((i) => i.name as string).filter(Boolean),
  };
}

// ── Hero selection ─────────────────────────────────────────────────────────--
const trimQuote = (s: string, max = 160) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[,;:\s]+\S*$/, "") + "…" : t;
};

/** Advertorial hero kind by angle: mechanism / anti-aging → ingredient; else avatar. */
export function advertorialHeroKind(angle: ProductAdAngle | null): AdvertorialHeroKind {
  const text = `${angle?.hook_slug || ""} ${angle?.desired_outcome || ""} ${angle?.lead_benefit_anchor || ""} ${angle?.pain_now || ""}`.toLowerCase();
  if (/aging|age|skin|antioxidant|mechanism|ingredient|clinical|inflammation|gut/.test(text)) return "ingredient";
  return "avatar";
}

const INGREDIENT_PROMPT = (title: string) =>
  `Photorealistic overhead flat-lay of the natural superfood ingredients that go into "${title}" — whole mushrooms (chaga, cordyceps), turmeric root, cacao, maca, coffee beans — arranged on a warm stone surface in soft natural light. Editorial food-photography look, shallow depth of field, no text, no packaging, no people.`;

const FACE_PROMPT =
  `Authentic candid headshot portrait of a friendly, healthy woman in her late 50s with natural grey hair and a warm genuine smile, wearing a casual sweater, bright softly-blurred home kitchen behind her. Natural window light, photorealistic, non-stock, no text.`;

// ── Build (per archetype → composition props w/ fresh URLs) ──────────────────
export interface BuiltStatic { composition: string; props: Record<string, unknown>; landerKind: LanderKind; }

export async function buildKillerStatic(args: {
  workspaceId: string;
  productId: string;
  archetype: KillerArchetype;
  assets: KillerAssets;
  angle: ProductAdAngle | null;
}): Promise<BuiltStatic> {
  const { workspaceId, productId, archetype, assets, angle } = args;
  const a = assets;
  const product = await signAdToolRef(a.isolatedProductUrl); // transparent cutout, never product-on-white
  const landerKind = ARCHETYPE_LANDER[archetype];

  if (archetype === "advertorial") {
    const wantKind = advertorialHeroKind(angle);
    let hero: string | null = null;
    let usedKind: AdvertorialHeroKind = wantKind;
    if (wantKind === "avatar") hero = await signAdToolRef(a.heroRefs[0]);
    if (!hero) { hero = await ensureGeneratedImage(workspaceId, `statics/${productId}/ingredient-flatlay.png`, INGREDIENT_PROMPT(a.productTitle), "4:5"); usedKind = "ingredient"; }
    const copy = await generateAdvertorialCopy(workspaceId, a.inputs, angle, usedKind);
    return {
      composition: KILLER_COMPOSITION.advertorial,
      landerKind,
      props: {
        publication: "THE SUPERFOODS REPORT", sponsorLabel: "SPONSORED",
        category: copy.category, byline: "By the Editorial Team", dateLabel: monthLabel(),
        headline: copy.headline, dek: copy.dek, body: copy.body,
        heroImageUrl: hero, heroCaption: copy.heroCaption,
        heroHeightPx: 380, heroObjectPosition: usedKind === "avatar" ? "center 25%" : "center",
        rating: a.rating, reviewCount: a.reviewCountDisplay, badges: a.badges,
        guarantee: a.inputs.guarantee_copy || "Backed by a 30-day money-back guarantee.",
        cta: "Read more →", accent: ACCENT, fontMode: "editorial",
      },
    };
  }

  if (archetype === "testimonial") {
    const r = a.reviews[0];
    const face = await ensureGeneratedImage(workspaceId, `statics/${productId}/face-testimonial.png`, FACE_PROMPT, "1:1");
    return {
      composition: KILLER_COMPOSITION.testimonial,
      landerKind,
      props: {
        brandBg: DEFAULT_BRAND.bg, accent: ACCENT,
        quote: trimQuote(r?.smart_quote || r?.body || "This is the best I've ever tried.", 90),
        body: r?.body ? trimQuote(r.body, 180) : undefined,
        reviewerName: r?.reviewer_name || "Verified Customer",
        verified: !!r?.verified_purchase,
        faceImageUrl: face, productImageUrl: product, productTitle: a.productTitle,
        reviewCount: a.reviewCountDisplay, badges: a.badges, cta: "Shop now →",
      },
    };
  }

  if (archetype === "authority") {
    const e = a.endorsement;
    const face = await signAdToolRef(a.media["endorsement_1_avatar"]); // REAL endorser headshot
    return {
      composition: KILLER_COMPOSITION.authority,
      landerKind,
      props: {
        brandBg: DEFAULT_BRAND.bg, accent: ACCENT,
        expertName: e?.name || "Registered Dietitian", expertTitle: e?.title || "MS, RD",
        quote: trimQuote(e?.quote || "This checks all the boxes — antioxidant rich and it tastes delicious.", 180),
        bullets: (e?.bullets?.length ? e.bullets : a.inputs.lead_benefits.map((b) => b.name)).filter(Boolean).slice(0, 3),
        faceImageUrl: face, productImageUrl: product, productTitle: a.productTitle,
        badges: a.badges, cta: "Learn more →",
      },
    };
  }

  if (archetype === "ingredient_breakdown") {
    const copy = await generateIngredientBreakdownCopy(workspaceId, a.inputs, angle, a.ingredientNames);
    const hero = await ensureBreakdownHero(workspaceId, productId, a);
    return {
      composition: KILLER_COMPOSITION.ingredient_breakdown,
      landerKind,
      props: {
        headline: copy.headline, productLabel: copy.productLabel,
        ingredients: copy.ingredients, heroImageUrl: hero,
      },
    };
  }

  if (archetype === "big_claim") {
    const copy = await generateBigClaimCopy(workspaceId, a.inputs, angle);
    return {
      composition: KILLER_COMPOSITION.big_claim,
      landerKind,
      props: {
        accent: ACCENT, eyebrow: copy.eyebrow, hook: copy.hook, emphasis: copy.emphasis, reveal: copy.reveal,
        productImageUrl: product, productTitle: a.productTitle, badges: a.badges, cta: "Shop now →",
      },
    };
  }

  // before_after — real customer before/after photos
  const copy = await generateBeforeAfterCopy(workspaceId, a.inputs, angle);
  const before = await signAdToolRef(a.media["before"]);
  const after = await signAdToolRef(a.media["after"]);
  return {
    composition: KILLER_COMPOSITION.before_after,
    landerKind,
    props: {
      accent: ACCENT, headline: copy.headline, beforeLabel: "Before", afterLabel: "After",
      beforeText: copy.beforeText, afterText: copy.afterText,
      beforeImageUrl: before, afterImageUrl: after, productTitle: a.productTitle,
      badges: a.badges, cta: "Shop now →",
    },
  };
}

function monthLabel(): string {
  const d = new Date();
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
